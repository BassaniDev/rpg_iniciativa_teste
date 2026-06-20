'use strict';

/* ════════════════════════════════════════════════════════════════
   D20 INITIATIVE TRACKER — APP.JS
   Arquitetura: State-Driven UI (a UI nunca é alterada diretamente
   por um evento; todo evento atualiza o `state` e em seguida chama
   uma função de render() que reconstrói a UI a partir do state).
   Isso evita o bug clássico de "card removido na minha tela mas
   continua visível na do outro jogador" — cada cliente sempre
   redesenha a partir da MESMA fonte de verdade (state local,
   sincronizado via broadcast).
   ════════════════════════════════════════════════════════════════ */

// ══════════════════════════════════════════════════════════════
//  ⚙️ CONFIGURAÇÃO SUPABASE — SUBSTITUA AQUI
//  Obtenha esses valores em: https://app.supabase.com
//  Projeto → Settings → API → Project URL + chave "anon public"
//  Veja SETUP.md para o passo a passo completo (incluindo as
//  regras de Row Level Security recomendadas).
// ══════════════════════════════════════════════════════════════
const SUPABASE_URL = 'https://zpogdcsdnebugklkezsu.supabase.co'; // ex: https://xxxxxxxx.supabase.co
const SUPABASE_ANON_KEY = 'sb_publishable_kNxJOtAs0X9JNDiVPaqMvA_xCHaHIfW'; // chave pública "anon"
// ══════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────
//  CONSTANTES
// ──────────────────────────────────────────────────────────────
const LS_NICKNAME = 'rpg_initiative_nickname';
const LS_ROOM = 'rpg_initiative_room';
const LS_IS_GM = 'rpg_initiative_isgm';
const LOG_MAX = 80;
const DICE_MAX = 20; // tamanho do dado (d20). Trocar aqui para suportar outros dados.
const NICKNAME_MAX_LEN = 24;
const ROOM_MAX_LEN = 40;
const MODIFIER_MIN = -99;
const MODIFIER_MAX = 99;

let supabaseClient = null;
let channel = null;

// Trava simples para impedir múltiplos cliques/rolagens simultâneas
// do MESMO cliente antes do broadcast anterior terminar de enviar.
// (Race condition local: clique duplo no botão Rolar.)
let rollInFlight = false;

/** Estado local — fonte única de verdade para toda a renderização. */
const state = {
  nickname: '',
  room: '',
  isGM: false,
  round: 1,
  myRoll: null,
  hasRolled: false,
  players: {}, // { userId: PlayerRecord }
  enemies: {}, // { enemyId: EnemyProfile } — perfis criados pelo GM
  userId: '',
  pendingModifierContext: null, // guarda o que fazer quando o modal de modificador confirmar
};

const logLines = [];

/**
 * PlayerRecord shape:
 * {
 *   id, nickname, isGM, online, roll, staticMod, dynamicMod,
 *   total, rolledAt, rolledAtStr, isEnemy, hidden, sourceEnemyId
 * }
 */

// ──────────────────────────────────────────────────────────────
//  UTILITÁRIOS
// ──────────────────────────────────────────────────────────────

/**
 * Gera um ID único e robusto combinando timestamp + valor aleatório.
 * 🔒 TRAVA: evita colisão de IDs mesmo que dois jogadores usem o
 * mesmo nickname, ou que dois cliques aconteçam no mesmo milissegundo
 * (o sufixo aleatório de base36 reduz drasticamente a chance de colisão).
 */
function genUniqueId(prefix = 'id') {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${ts}_${rand}`;
}

function nowTime() {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function colorFromString(str) {
  const palette = [
    ['#7C3AED', '#06B6D4'], ['#06B6D4', '#22D3EE'], ['#F59E0B', '#EF4444'],
    ['#22C55E', '#06B6D4'], ['#EF4444', '#7C3AED'], ['#8B5CF6', '#EC4899'],
    ['#14B8A6', '#6366F1'], ['#F97316', '#FBBF24'],
  ];
  const safe = sanitizeText(str) || '?';
  let h = 0;
  for (const c of safe) h = (h * 31 + c.charCodeAt(0)) % palette.length;
  return palette[Math.abs(h)];
}

function initials(nick) {
  const safe = sanitizeText(nick);
  return safe ? safe.slice(0, 2).toUpperCase() : '??';
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 🔒 TRAVA DE SANITIZAÇÃO: remove espaços nas pontas e garante que
 * sempre retornamos uma string (nunca null/undefined/NaN), prevenindo
 * que inputs vazios ou maliciosos quebrem a renderização ou a lógica
 * de ordenação mais adiante.
 */
function sanitizeText(value, maxLen = 64) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

/**
 * 🔒 TRAVA NUMÉRICA: converte qualquer input (string vazia, texto,
 * undefined, NaN) em um número inteiro seguro dentro de um intervalo.
 * Usado em TODOS os pontos onde um modificador entra no sistema —
 * é a principal defesa contra "o jogador mandou um campo vazio e o
 * JS quebrou ao tentar somar number + undefined = NaN".
 */
function safeInt(value, fallback = 0, min = -999, max = 999) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Rola 1dN usando Math.random (PRNG do navegador). */
function rollDie(sides = DICE_MAX) {
  return Math.floor(Math.random() * sides) + 1;
}

// ──────────────────────────────────────────────────────────────
//  WEB AUDIO API — SONS (sem biblioteca externa)
// ──────────────────────────────────────────────────────────────
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playSoundRoll() {
  try {
    const ctx = getAudioContext();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    filter.type = 'bandpass';
    filter.frequency.value = 800;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    src.buffer = buf;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start();
  } catch (_) { /* silencioso se o áudio estiver bloqueado pelo navegador */ }
}

function playSoundNat20() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.5);
    gain.connect(ctx.destination);
    [261.63, 329.63, 392.0, 523.25].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(now + i * 0.08);
      osc.stop(now + 1.5);
    });
  } catch (_) {}
}

function playSoundNat1() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.6);
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.6);
  } catch (_) {}
}

// ──────────────────────────────────────────────────────────────
//  PARTÍCULAS (CRÍTICO NAT 20)
// ──────────────────────────────────────────────────────────────
function spawnParticles(originEl) {
  const rect = originEl?.getBoundingClientRect() ?? { left: window.innerWidth / 2, top: window.innerHeight / 2 };
  const cx = rect.left + (rect.width || 0) / 2;
  const cy = rect.top + (rect.height || 0) / 2;
  const colors = ['#F59E0B', '#FCD34D', '#7C3AED', '#22D3EE', '#fff'];

  for (let i = 0; i < 20; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const size = 4 + Math.random() * 8;
    const angle = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 100;
    p.style.cssText = `
      left:${cx}px; top:${cy}px;
      width:${size}px; height:${size}px;
      background:${colors[i % colors.length]};
      --tx:${Math.cos(angle) * dist}px;
      --ty:${Math.sin(angle) * dist - 40}px;
      animation-duration:${0.7 + Math.random() * 0.5}s;
      animation-delay:${Math.random() * 0.1}s;
    `;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 1500);
  }
}

// ──────────────────────────────────────────────────────────────
//  TOASTS
// ──────────────────────────────────────────────────────────────
function showToast(msg, type = 'info', duration = 3500) {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => {
    t.classList.add('fade-out');
    setTimeout(() => t.remove(), 400);
  }, duration);
}

// ──────────────────────────────────────────────────────────────
//  MODAL NAT 20 / NAT 1
// ──────────────────────────────────────────────────────────────
let natModalTimer = null;

function showNatModal({ isNat20, playerNick, value }) {
  const el = document.getElementById('modal-nat');
  if (!el) return;
  const safeNick = escapeHtml(sanitizeText(playerNick) || 'Alguém');

  document.getElementById('modal-icon').textContent = isNat20 ? '⚔️' : '💀';
  const titleEl = document.getElementById('modal-title');
  titleEl.textContent = isNat20 ? `CRÍTICO! NAT ${value}!` : 'FALHA CRÍTICA!';
  titleEl.className = `modal-title ${isNat20 ? 'accent-ember' : 'accent-danger'}`;
  document.getElementById('modal-msg').textContent = isNat20
    ? `${safeNick} convocou os deuses do dado e tirou um ${value} natural!`
    : `${safeNick} tropeçou no próprio escudo e tirou 1... Que os deuses tenham piedade.`;

  el.classList.remove('hidden');
  clearTimeout(natModalTimer);
  natModalTimer = setTimeout(closeNatModal, 5000);
}

function closeNatModal() {
  document.getElementById('modal-nat')?.classList.add('hidden');
  clearTimeout(natModalTimer);
}

// ──────────────────────────────────────────────────────────────
//  LOG DE COMBATE
// ──────────────────────────────────────────────────────────────
const logColors = {
  nat20: 'log-msg-nat20',
  nat1: 'log-msg-nat1',
  join: 'log-msg-join',
  leave: 'log-msg-leave',
  round: 'log-msg-round',
  gm: 'log-msg-gm',
  default: 'log-msg-default',
};

function addLog(msg, type = 'default') {
  logLines.push({ msg: sanitizeText(msg, 200), type, time: nowTime() });
  if (logLines.length > LOG_MAX) logLines.shift();
  renderLog();
}

function renderLog() {
  const targets = [document.getElementById('combat-log'), document.getElementById('combat-log-mobile')];
  targets.forEach((logEl) => {
    if (!logEl) return;
    if (logLines.length === 0) {
      logEl.innerHTML = '<p class="empty-hint">Nenhum evento ainda</p>';
      return;
    }
    logEl.innerHTML = [...logLines]
      .reverse()
      .map(
        ({ msg, type, time }) => `
        <div class="log-entry">
          <span class="log-time">${time}</span>
          <span class="${logColors[type] ?? logColors.default}">${escapeHtml(msg)}</span>
        </div>`
      )
      .join('');
  });
}

// ──────────────────────────────────────────────────────────────
//  ORDENAÇÃO / DERIVAÇÃO DE LISTAS (tudo derivado do `state`)
// ──────────────────────────────────────────────────────────────

/**
 * Jogadores/inimigos que ainda NÃO rolaram (e estão online) ficam
 * na "Sala de Espera". Assim que rolam, são considerados parte da
 * Lista de Iniciativa Ativa — a transição é automática porque a
 * lista é sempre DERIVADA do state, nunca movida manualmente no DOM.
 */
function getWaitingList() {
  return Object.values(state.players).filter((p) => p.online && p.roll === null);
}

/**
 * Lista de Iniciativa Ativa: todos que já rolaram nesta rodada,
 * ordenados do maior total para o menor.
 * 🔒 CRITÉRIO DE DESEMPATE: se o total final for igual, quem tiver
 * maior MODIFICADOR ESTÁTICO fica na frente (representa personagens
 * "naturalmente" mais rápidos/atentos). Se ainda houver empate,
 * quem rolou primeiro (rolledAt menor) mantém prioridade — isso
 * garante um resultado determinístico e estável mesmo se dois
 * jogadores derem o mesmo resultado total no mesmo milissegundo.
 */
function getActiveInitiativeList() {
  return Object.values(state.players)
    .filter((p) => p.roll !== null)
    .sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      if (b.staticMod !== a.staticMod) return b.staticMod - a.staticMod;
      return (a.rolledAt ?? 0) - (b.rolledAt ?? 0);
    });
}

function rollClass(val) {
  if (val === null || val === undefined) return 'empty';
  if (val === DICE_MAX) return 'nat20';
  if (val === 1) return 'nat1';
  return 'normal';
}

function diceIconSvg(val, highlight = false) {
  const fill = highlight ? 'rgba(124,58,237,0.4)' : 'rgba(30,41,66,0.8)';
  const stroke = highlight ? '#A855F7' : '#2D3F6B';
  const label = val !== null && val !== undefined ? escapeHtml(String(val)) : '';
  return `
    <svg width="44" height="44" viewBox="0 0 72 72" class="flex-none" aria-hidden="true">
      <polygon points="36,6 66,22 66,50 36,66 6,50 6,22" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
      <polygon points="36,6 66,22 36,30" fill="rgba(255,255,255,0.06)"/>
      <polygon points="6,22 36,30 36,6" fill="rgba(0,0,0,0.08)"/>
      ${label ? `<text x="36" y="38" text-anchor="middle" font-family="Cinzel,serif" font-size="${val >= 10 ? '14' : '16'}" font-weight="900" fill="${highlight ? '#C084FC' : '#94A3B8'}" dy="0.3em">${label}</text>` : ''}
    </svg>`;
}

// ──────────────────────────────────────────────────────────────
//  RENDER: SALA DE ESPERA
// ──────────────────────────────────────────────────────────────
function renderWaitingRoom() {
  const list = document.getElementById('waiting-list');
  const countEl = document.getElementById('waiting-count');
  if (!list) return;

  const waiting = getWaitingList();
  countEl.textContent = `${waiting.length} presente${waiting.length === 1 ? '' : 's'}`;

  if (waiting.length === 0) {
    list.innerHTML = '<p class="empty-hint">Aguardando jogadores entrarem na sala...</p>';
    return;
  }

  list.innerHTML = waiting
    .map((p) => {
      const colors = colorFromString(p.nickname);
      const displayName = resolveDisplayName(p);
      return `
        <div class="waiting-chip">
          <div class="avatar-circle" style="background:linear-gradient(135deg, ${colors[0]}, ${colors[1]});">${initials(displayName)}</div>
          <span class="waiting-chip-name">${escapeHtml(displayName)}</span>
          ${p.isGM ? '<span class="waiting-chip-tag">GM</span>' : ''}
        </div>`;
    })
    .join('');
}

/**
 * Resolve o nome a ser exibido para um jogador/inimigo, respeitando
 * o Modo Furtivo do GM: se `hidden` estiver ativo e quem está vendo
 * NÃO for o GM, mostramos "Inimigo Oculto" em vez do nome real.
 */
function resolveDisplayName(record) {
  if (record.isEnemy && record.hidden && !state.isGM) {
    return 'Inimigo Oculto';
  }
  return record.nickname;
}

// ──────────────────────────────────────────────────────────────
//  RENDER: CARD DE INICIATIVA
// ──────────────────────────────────────────────────────────────
function buildPlayerCard(player, rank) {
  const isMe = player.id === state.userId;
  const displayName = resolveDisplayName(player);
  const colors = colorFromString(displayName);
  const hasRolled = player.roll !== null;
  const rClass = rollClass(player.roll);
  const barWidth = hasRolled ? Math.max(0, Math.min(100, Math.round((player.total / DICE_MAX) * 100))) : 0;
  const rankBadgeClass = rank === 0 ? 'rank-1' : rank === 1 ? 'rank-2' : rank === 2 ? 'rank-3' : 'rank-n';
  const rankLabel = hasRolled ? rank + 1 : '?';

  const cardClasses = [
    'player-card',
    isMe ? 'is-mine' : '',
    !player.online ? 'is-offline' : '',
    player.isEnemy ? 'is-enemy' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const modsHtml = hasRolled
    ? `<div class="card-mods-row">
        <span class="mod-chip">d20: ${player.roll}</span>
        ${player.staticMod ? `<span class="mod-chip">Fixo: ${player.staticMod > 0 ? '+' : ''}${player.staticMod}</span>` : ''}
        ${player.dynamicMod ? `<span class="mod-chip">Situacional: ${player.dynamicMod > 0 ? '+' : ''}${player.dynamicMod}</span>` : ''}
      </div>`
    : '';

  return `
    <div id="card-${player.id}" class="${cardClasses}">
      <div class="card-top-row">
        <div class="avatar-wrap">
          <div class="avatar-circle" style="background:linear-gradient(135deg, ${colors[0]}, ${colors[1]});">${initials(displayName)}</div>
          <span class="status-dot ${player.online ? 'online' : 'offline'}"></span>
        </div>
        <div class="card-name-block">
          <div class="card-name-row">
            <span class="card-name">${escapeHtml(displayName)}</span>
            ${isMe ? '<span class="card-tag card-tag-me">EU</span>' : ''}
            ${player.isGM ? '<span class="card-tag card-tag-gm">GM</span>' : ''}
            ${player.isEnemy ? '<span class="card-tag card-tag-enemy">Inimigo</span>' : ''}
          </div>
          <div class="card-subtext">
            ${player.online ? 'Online' : 'Offline'} · ${hasRolled ? `Rolou às ${player.rolledAtStr ?? '—'}` : 'Aguardando...'}
          </div>
        </div>
        <div class="rank-badge ${rankBadgeClass}" title="Posição na iniciativa">${rankLabel}</div>
      </div>

      <div class="card-roll-row">
        <div>
          ${
            hasRolled
              ? `<div class="dice-value ${rClass}">${player.total}</div>
                 <div class="roll-caption ${rClass === 'nat20' ? 'crit' : rClass === 'nat1' ? 'fail' : ''}">
                   ${rClass === 'nat20' ? '⚔️ CRÍTICO NATURAL!' : rClass === 'nat1' ? '💀 FALHA CRÍTICA!' : 'Total de Iniciativa'}
                 </div>`
              : `<div class="dice-value empty">—</div><div class="roll-caption">Não rolou</div>`
          }
        </div>
        ${diceIconSvg(player.roll, isMe)}
      </div>

      ${modsHtml}

      <div class="card-bar-block">
        <div class="card-bar-labels"><span>Iniciativa</span><span>${hasRolled ? `${player.total}/${DICE_MAX}` : '?'}</span></div>
        <div class="rank-bar-track"><div class="rank-bar ${rClass === 'nat20' ? 'crit' : rClass === 'nat1' ? 'fail' : ''}" style="width:${barWidth}%;"></div></div>
      </div>
    </div>`;
}

/**
 * 🔒 STATE-DRIVEN UI: esta função SEMPRE reconstrói o grid inteiro
 * a partir de `state.players`. Nunca removemos/adicionamos um card
 * isoladamente em resposta a um evento de rede — isso é o que evita
 * o bug de "card excluído na minha tela, mas continua visível na
 * tela de outro jogador": cada cliente redesenha 100% da lista a
 * cada atualização de estado, então não existe estado parcial.
 */
function renderPlayersGrid() {
  const grid = document.getElementById('players-grid');
  if (!grid) return;

  const active = getActiveInitiativeList();
  const onlineCount = Object.values(state.players).filter((p) => p.online).length;

  const headerCount = document.getElementById('header-players-count');
  const rollStatus = document.getElementById('roll-status-text');
  const totalParticipants = Object.values(state.players).filter((p) => p.online || p.roll !== null).length;
  if (headerCount) headerCount.textContent = onlineCount;
  if (rollStatus) rollStatus.textContent = `${active.length}/${totalParticipants || active.length} rolaram`;

  if (active.length === 0) {
    grid.innerHTML = `
      <div id="empty-state" class="empty-state">
        <svg width="48" height="48" viewBox="0 0 72 72" class="empty-state-icon" aria-hidden="true">
          <polygon points="36,6 66,22 66,50 36,66 6,50 6,22" fill="#7C3AED" stroke="#A855F7" stroke-width="2"/>
          <text x="36" y="40" text-anchor="middle" font-family="Cinzel,serif" font-size="18" font-weight="900" fill="white">20</text>
        </svg>
        <p class="empty-state-text">Nenhuma iniciativa rolada ainda</p>
        <p class="empty-state-subtext">Role o dado para entrar na ordem de combate</p>
      </div>`;
  } else {
    grid.innerHTML = active.map((p, i) => buildPlayerCard(p, i)).join('');
  }

  renderWaitingRoom();
  updateMyStatusBar();
}

function updateMyStatusBar() {
  const bar = document.getElementById('my-status-bar');
  const nick = document.getElementById('my-nickname-sm');
  const rollText = document.getElementById('my-roll-sm');
  const val = document.getElementById('my-value-sm');
  if (!bar || !state.nickname) {
    bar?.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  nick.textContent = state.nickname;

  const me = state.players[state.userId];
  const myTotal = me?.total ?? null;

  if (myTotal !== null && myTotal !== undefined) {
    const cls = rollClass(me.roll);
    rollText.textContent = `Total ${myTotal} — ${cls === 'nat20' ? '⚔️ CRÍTICO!' : cls === 'nat1' ? '💀 FALHA!' : 'rolado'}`;
    val.textContent = myTotal;
    val.className = `my-status-value dice-value ${cls}`;
  } else {
    rollText.textContent = 'Não rolou ainda';
    val.textContent = '—';
    val.className = 'my-status-value';
  }

  const colors = colorFromString(state.nickname);
  [document.getElementById('my-avatar-sm'), document.getElementById('header-avatar')].forEach((av) => {
    if (!av) return;
    av.textContent = initials(state.nickname);
    av.style.background = `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`;
  });
}

function animateCard(userId, value) {
  const card = document.getElementById(`card-${userId}`);
  if (!card) return;
  card.classList.remove('rolling', 'nat20-effect', 'nat1-effect');
  void card.offsetWidth; // força reflow para reiniciar a animação CSS
  if (value === DICE_MAX) {
    card.classList.add('nat20-effect');
    spawnParticles(card);
  } else if (value === 1) {
    card.classList.add('nat1-effect');
  } else {
    card.classList.add('rolling');
  }
}

// ──────────────────────────────────────────────────────────────
//  MODAL: MODIFICADOR DINÂMICO (antes de confirmar a rolagem)
// ──────────────────────────────────────────────────────────────
function openModifierModal(context) {
  state.pendingModifierContext = context;
  document.getElementById('input-modifier').value = '';
  document.getElementById('modal-modifier').classList.remove('hidden');
  setTimeout(() => document.getElementById('input-modifier')?.focus(), 50);
}

function closeModifierModal() {
  document.getElementById('modal-modifier').classList.add('hidden');
  state.pendingModifierContext = null;
}

function confirmModifierModal() {
  const raw = document.getElementById('input-modifier').value;
  // 🔒 TRAVA: campo vazio ou inválido = modificador 0, nunca NaN/undefined.
  const dynamicMod = safeInt(raw, 0, MODIFIER_MIN, MODIFIER_MAX);
  const context = state.pendingModifierContext;
  closeModifierModal();
  if (!context) return;

  if (context.type === 'player_roll') {
    executePlayerRoll(dynamicMod);
  } else if (context.type === 'enemy_roll') {
    executeEnemyRoll(context.enemyId, dynamicMod);
  }
}

// ──────────────────────────────────────────────────────────────
//  ROLAGEM DO JOGADOR
// ──────────────────────────────────────────────────────────────
function rollDiceClicked() {
  if (!state.nickname) return;
  if (state.hasRolled) {
    showToast('Você já rolou nesta rodada. Aguarde a próxima rodada.', 'info');
    return;
  }
  // 🔒 TRAVA: impede que o usuário abra dois modais/disparos simultâneos
  // clicando rápido duas vezes (mini race condition local no cliente).
  if (rollInFlight) return;
  openModifierModal({ type: 'player_roll' });
}

async function executePlayerRoll(dynamicMod) {
  if (state.hasRolled || rollInFlight) return;
  rollInFlight = true;

  const btn = document.getElementById('btn-roll');
  btn.disabled = true;

  try {
    const me = state.players[state.userId];
    const staticMod = me?.staticMod ?? 0;
    const roll = rollDie(DICE_MAX);
    const total = roll + staticMod + dynamicMod;
    const timestamp = Date.now();

    state.hasRolled = true;
    state.myRoll = roll;
    applyRollToPlayer(state.userId, { roll, staticMod, dynamicMod, total, rolledAt: timestamp, rolledAtStr: nowTime() });

    playSoundRollFeedback(roll);
    renderPlayersGrid();
    animateCard(state.userId, roll);
    announceRollLocally(state.nickname, roll, total);

    await broadcastDiceRoll({
      userId: state.userId,
      nickname: state.nickname,
      isGM: state.isGM,
      isEnemy: false,
      hidden: false,
      roll,
      staticMod,
      dynamicMod,
      total,
      rolledAt: timestamp,
      rolledAtStr: nowTime(),
    });
  } finally {
    rollInFlight = false;
  }
}

function playSoundRollFeedback(roll) {
  if (roll === DICE_MAX) playSoundNat20();
  else if (roll === 1) playSoundNat1();
  else playSoundRoll();
}

function announceRollLocally(nickname, roll, total) {
  const safeName = sanitizeText(nickname) || 'Alguém';
  if (roll === DICE_MAX) {
    showToast(`⚔️ ${safeName} tirou NAT 20! CRÍTICO!`, 'nat20', 5000);
    showNatModal({ isNat20: true, playerNick: safeName, value: roll });
  } else if (roll === 1) {
    showToast(`💀 ${safeName} falhou criticamente!`, 'error', 4000);
    showNatModal({ isNat20: false, playerNick: safeName, value: roll });
  } else {
    showToast(`🎲 ${safeName} rolou ${roll} (total ${total})`, 'info', 2500);
  }
  const logType = roll === DICE_MAX ? 'nat20' : roll === 1 ? 'nat1' : 'default';
  addLog(`${safeName} rolou ${roll}${roll !== total ? ` (total ${total})` : ''}${roll === DICE_MAX ? ' — CRÍTICO!' : roll === 1 ? ' — FALHA!' : ''}`, logType);
}

/**
 * Aplica um resultado de rolagem a um registro de jogador no state.
 * 🔒 TRAVA: cria o registro se não existir (defesa contra eventos
 * de rolagem chegando antes do evento de presence/join, o que pode
 * acontecer com latência de rede variável entre clientes).
 */
function applyRollToPlayer(userId, payload) {
  if (!state.players[userId]) {
    state.players[userId] = {
      id: userId,
      nickname: sanitizeText(payload.nickname) || 'Anônimo',
      isGM: !!payload.isGM,
      isEnemy: !!payload.isEnemy,
      hidden: !!payload.hidden,
      online: true,
      roll: null,
      staticMod: 0,
      dynamicMod: 0,
      total: null,
      rolledAt: null,
      rolledAtStr: null,
    };
  }
  const p = state.players[userId];
  p.roll = safeInt(payload.roll, 0, 1, DICE_MAX);
  p.staticMod = safeInt(payload.staticMod, 0, MODIFIER_MIN, MODIFIER_MAX);
  p.dynamicMod = safeInt(payload.dynamicMod, 0, MODIFIER_MIN, MODIFIER_MAX);
  p.total = safeInt(payload.total, p.roll + p.staticMod + p.dynamicMod, -999, 999);
  p.rolledAt = payload.rolledAt ?? Date.now();
  p.rolledAtStr = sanitizeText(payload.rolledAtStr) || nowTime();
  if (payload.hidden !== undefined) p.hidden = !!payload.hidden;
}

// ──────────────────────────────────────────────────────────────
//  PAINEL DO MESTRE — PERFIS DE INIMIGOS
// ──────────────────────────────────────────────────────────────
function openGmPanel() {
  document.getElementById('modal-gm').classList.remove('hidden');
  renderEnemyList();
}

function closeGmPanel() {
  document.getElementById('modal-gm').classList.add('hidden');
}

/**
 * Cria um perfil de inimigo reutilizável. Apenas local até o GM
 * decidir "rolar" por ele — o perfil em si não precisa de
 * sincronização (só a ação de rolagem precisa).
 */
function createEnemyProfile(name, staticMod, hidden) {
  const safeName = sanitizeText(name, 30);
  if (!safeName) {
    showToast('Digite um nome para o inimigo.', 'error');
    return;
  }
  const id = genUniqueId('enemy');
  state.enemies[id] = {
    id,
    name: safeName,
    staticMod: safeInt(staticMod, 0, MODIFIER_MIN, MODIFIER_MAX),
    hidden: !!hidden,
  };
  renderEnemyList();
  showToast(`👹 Perfil "${safeName}" criado.`, 'success', 2500);
}

function deleteEnemyProfile(id) {
  delete state.enemies[id];
  renderEnemyList();
}

function renderEnemyList() {
  const list = document.getElementById('enemy-list');
  if (!list) return;
  const enemies = Object.values(state.enemies);

  if (enemies.length === 0) {
    list.innerHTML = '<p class="empty-hint">Nenhum inimigo cadastrado ainda.</p>';
    return;
  }

  list.innerHTML = enemies
    .map(
      (e) => `
      <div class="enemy-row" id="enemy-row-${e.id}">
        <div class="enemy-row-info">
          <div class="enemy-row-name">
            ${escapeHtml(e.name)}
            ${e.hidden ? '<span class="card-tag card-tag-enemy">Furtivo</span>' : ''}
          </div>
          <div class="enemy-row-meta">Modificador fixo: ${e.staticMod > 0 ? '+' : ''}${e.staticMod}</div>
        </div>
        <div class="enemy-row-actions">
          <button class="small-btn" type="button" data-action="roll-enemy" data-id="${e.id}">Rolar</button>
          <button class="small-btn danger" type="button" data-action="delete-enemy" data-id="${e.id}">Remover</button>
        </div>
      </div>`
    )
    .join('');
}

/** GM clicou em "Rolar" para um inimigo: abre modal de modificador situacional. */
function startEnemyRoll(enemyId) {
  if (!state.enemies[enemyId]) return;
  openModifierModal({ type: 'enemy_roll', enemyId });
}

async function executeEnemyRoll(enemyId, dynamicMod) {
  const profile = state.enemies[enemyId];
  if (!profile) return;

  // 🔒 TRAVA DE CONCORRÊNCIA / ID ÚNICO: cada ação de rolagem do GM
  // gera uma NOVA entrada de "instância de combate" com ID próprio
  // (não reutiliza o id do perfil), permitindo que o mesmo inimigo
  // (ex: "Lobo Sombrio") apareça múltiplas vezes na iniciativa sem
  // colidir IDs — útil para grupos de monstros iguais.
  const instanceId = genUniqueId(`enemyroll_${profile.id}`);
  const roll = rollDie(DICE_MAX);
  const total = roll + profile.staticMod + dynamicMod;
  const timestamp = Date.now();

  applyRollToPlayer(instanceId, {
    nickname: profile.name,
    isGM: false,
    isEnemy: true,
    hidden: profile.hidden,
    roll,
    staticMod: profile.staticMod,
    dynamicMod,
    total,
    rolledAt: timestamp,
    rolledAtStr: nowTime(),
  });
  state.players[instanceId].online = true;

  renderPlayersGrid();
  animateCard(instanceId, roll);
  playSoundRollFeedback(roll);

  const displayName = profile.hidden ? 'Inimigo Oculto' : profile.name;
  addLog(`${state.isGM ? 'GM' : 'Alguém'} rolou iniciativa para ${displayName}: ${roll} (total ${total})`, roll === DICE_MAX ? 'nat20' : roll === 1 ? 'nat1' : 'gm');

  await broadcastDiceRoll({
    userId: instanceId,
    nickname: profile.name,
    isGM: false,
    isEnemy: true,
    hidden: profile.hidden,
    roll,
    staticMod: profile.staticMod,
    dynamicMod,
    total,
    rolledAt: timestamp,
    rolledAtStr: nowTime(),
  });
}

// ──────────────────────────────────────────────────────────────
//  CONTROLE DE RODADA (GM) — RESET DE TURNO
// ──────────────────────────────────────────────────────────────

/**
 * Limpa todas as rolagens da rodada atual (mas mantém os jogadores
 * conectados na sala). Usado tanto para "Próxima Rodada" quanto
 * para "Limpar Iniciativas" — a diferença é se o contador de
 * rodada avança ou não.
 * 🔒 TRAVA: instâncias de inimigo (que só existem após rolar) são
 * removidas do state por completo, evitando "fantasmas" de inimigos
 * mortos/já resolvidos acumulando na sala de espera.
 */
function resetRollsInState() {
  Object.keys(state.players).forEach((id) => {
    const p = state.players[id];
    if (p.isEnemy) {
      delete state.players[id]; // instância de combate descartada
      return;
    }
    p.roll = null;
    p.staticMod = p.staticMod ?? 0;
    p.dynamicMod = 0;
    p.total = null;
    p.rolledAt = null;
    p.rolledAtStr = null;
  });
  state.myRoll = null;
  state.hasRolled = false;
}

function applyNextRound(round) {
  state.round = safeInt(round, state.round + 1, 1, 9999);
  resetRollsInState();
  document.getElementById('header-round').textContent = state.round;
  document.getElementById('round-badge').textContent = `Rodada ${state.round}`;
  addLog(`── Rodada ${state.round} iniciada pelo GM ──`, 'round');
  renderPlayersGrid();
  resetRollButtonUI();
  showToast(`⚔️ Rodada ${state.round} começou!`, 'info');
}

function applyClearRolls() {
  resetRollsInState();
  addLog('GM limpou as iniciativas da rodada.', 'gm');
  renderPlayersGrid();
  resetRollButtonUI();
  showToast('🗑️ Iniciativas limpas pelo GM', 'info');
}

function resetRollButtonUI() {
  const btn = document.getElementById('btn-roll');
  if (!btn) return;
  btn.disabled = false;
  document.getElementById('btn-roll-text').textContent = 'ROLAR D20';
}

async function broadcastNextRound() {
  if (!state.isGM) return;
  const newRound = state.round + 1;
  applyNextRound(newRound);
  // 🔒 TRAVA: em modo local (sem Supabase configurado), `channel` é null —
  // a ação já foi aplicada localmente acima, então simplesmente pulamos o
  // envio de rede em vez de abortar a função inteira (bug anterior fazia
  // o botão "Próxima Rodada" não fazer nada quando offline).
  if (!channel) return;
  await channel.send({ type: 'broadcast', event: 'next_round', payload: { round: newRound, gmId: state.userId } });
}

async function broadcastClearRolls() {
  if (!state.isGM) return;
  applyClearRolls();
  if (!channel) return;
  await channel.send({ type: 'broadcast', event: 'clear_rolls', payload: { gmId: state.userId } });
}

// ──────────────────────────────────────────────────────────────
//  REDE: SUPABASE REALTIME (BROADCAST + PRESENCE)
// ──────────────────────────────────────────────────────────────

/**
 * Envia a rolagem para os outros clientes via Broadcast.
 * 🔒 TRAVA DE CONDIÇÃO DE CORRIDA: o evento de broadcast carrega o
 * ID único do jogador/instância junto com TODOS os dados já
 * calculados (roll, mods, total). Cada cliente que recebe o evento
 * apenas GRAVA esses valores no seu próprio state e re-renderiza —
 * nenhum cliente recalcula ou "adivinha" o resultado de outro
 * jogador. Isso elimina o cenário clássico de dois jogadores
 * rolando ao mesmo tempo e um sobrescrever o resultado do outro:
 * como cada jogador só escreve no seu PRÓPRIO id dentro de
 * `state.players`, não há chave compartilhada sendo disputada.
 */
async function broadcastDiceRoll(payload) {
  if (!channel) return; // modo local (sem Supabase configurado): só atualiza este cliente
  try {
    await channel.send({ type: 'broadcast', event: 'dice_roll', payload });
  } catch (err) {
    console.error('Falha ao transmitir rolagem:', err);
    showToast('⚠️ Falha de rede ao sincronizar rolagem. Tentando localmente.', 'error', 4000);
  }
}

async function connectRealtime(room) {
  if (!SUPABASE_URL || SUPABASE_URL.includes('COLE_AQUI') || !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes('COLE_AQUI')) {
    throw new Error('Credenciais Supabase não configuradas');
  }
  if (typeof window.supabase === 'undefined') {
    throw new Error('Biblioteca Supabase não carregada (verifique sua conexão de rede)');
  }

  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Canal único por sala — broadcast + presence isolados por nome de sala.
  channel = supabaseClient.channel(`initiative:${room}`, {
    config: {
      broadcast: { self: false }, // já aplicamos o efeito localmente antes de enviar
      presence: { key: state.userId },
    },
  });

  // ── Recebendo rolagem de outro cliente ──
  channel.on('broadcast', { event: 'dice_roll' }, ({ payload }) => {
    if (!payload || !payload.userId) return; // 🔒 TRAVA: ignora payloads malformados
    applyRollToPlayer(payload.userId, payload);
    renderPlayersGrid();
    animateCard(payload.userId, state.players[payload.userId].roll);

    const safeName = sanitizeText(payload.hidden && !state.isGM ? 'Inimigo Oculto' : payload.nickname) || 'Alguém';
    const roll = state.players[payload.userId].roll;
    const total = state.players[payload.userId].total;

    playSoundRollFeedback(roll);
    if (roll === DICE_MAX) {
      showToast(`⚔️ ${safeName} tirou NAT 20! CRÍTICO!`, 'nat20', 5000);
      showNatModal({ isNat20: true, playerNick: safeName, value: roll });
    } else if (roll === 1) {
      showToast(`💀 ${safeName} falhou criticamente!`, 'error', 4000);
    } else {
      showToast(`🎲 ${safeName} rolou ${roll}`, 'info', 2000);
    }
    addLog(`${safeName} rolou ${roll}${roll !== total ? ` (total ${total})` : ''}${roll === DICE_MAX ? ' — CRÍTICO!' : roll === 1 ? ' — FALHA!' : ''}`, roll === DICE_MAX ? 'nat20' : roll === 1 ? 'nat1' : 'default');
  });

  channel.on('broadcast', { event: 'next_round' }, ({ payload }) => {
    if (state.isGM) return; // o GM já aplicou localmente antes de transmitir
    applyNextRound(payload?.round);
  });

  channel.on('broadcast', { event: 'clear_rolls' }, () => {
    if (state.isGM) return;
    applyClearRolls();
  });

  // ── Presence: sincroniza quem está na sala ──
  channel.on('presence', { event: 'sync' }, () => {
    const presState = channel.presenceState();

    // Marca todos como offline antes de reaplicar — assim, quem saiu
    // (e não está mais no presenceState) permanece marcado como offline
    // em vez de continuar "online" indefinidamente.
    Object.values(state.players).forEach((p) => {
      if (!p.isEnemy) p.online = false;
    });

    Object.values(presState).forEach((presences) => {
      presences.forEach((presence) => {
        const uid = presence.userId;
        if (!uid) return; // 🔒 TRAVA: ignora presença sem ID
        if (!state.players[uid]) {
          state.players[uid] = {
            id: uid,
            nickname: sanitizeText(presence.nickname) || 'Anônimo',
            isGM: !!presence.isGM,
            isEnemy: false,
            hidden: false,
            online: true,
            roll: null,
            staticMod: 0,
            dynamicMod: 0,
            total: null,
            rolledAt: null,
            rolledAtStr: null,
          };
        } else {
          state.players[uid].online = true;
        }
      });
    });

    renderPlayersGrid();
  });

  channel.on('presence', { event: 'join' }, ({ newPresences }) => {
    newPresences.forEach((p) => {
      const nick = sanitizeText(p.nickname) || 'Alguém';
      if (p.userId !== state.userId) {
        addLog(`${nick} entrou na sala.`, 'join');
        showToast(`👤 ${nick} entrou na sala!`, 'success', 3000);
      }
    });
  });

  channel.on('presence', { event: 'leave' }, ({ leftPresences }) => {
    leftPresences.forEach((p) => {
      const nick = sanitizeText(p.nickname) || 'Alguém';
      if (p.userId !== state.userId) addLog(`${nick} saiu da sala.`, 'leave');
      // 🔒 TRAVA: mantém o registro do jogador (com a rolagem feita)
      // mas marca como offline — evita que a desconexão abrupta de
      // alguém apague o resultado da iniciativa que já foi rolada.
      if (state.players[p.userId]) state.players[p.userId].online = false;
    });
    renderPlayersGrid();
  });

  await channel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await channel.track({ userId: state.userId, nickname: state.nickname, isGM: state.isGM, joinedAt: Date.now() });
      addLog(`Conectado ao canal "${room}" via Supabase Realtime.`, 'gm');
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      showToast('❌ Erro no canal Realtime. Verifique suas credenciais Supabase.', 'error', 8000);
    }
  });
}

// ──────────────────────────────────────────────────────────────
//  ENTRADA / SAÍDA DA SALA
// ──────────────────────────────────────────────────────────────
async function enterRoom(nickname, room, isGM) {
  // 🔒 TRAVA DE VALIDAÇÃO: sanitiza e limita o tamanho de nickname/sala
  // ANTES de usá-los em qualquer lugar (UI, localStorage, nome de canal).
  const safeNickname = sanitizeText(nickname, NICKNAME_MAX_LEN);
  const safeRoom = sanitizeText(room, ROOM_MAX_LEN)
    .toLowerCase()
    .replace(/[^a-z0-9\-_]/g, '-');

  if (!safeNickname) {
    showToast('Digite seu nome/nickname!', 'error');
    return;
  }
  if (!safeRoom) {
    showToast('Digite o ID da sala!', 'error');
    return;
  }

  state.nickname = safeNickname;
  state.room = safeRoom;
  state.isGM = !!isGM;
  state.userId = genUniqueId('user');
  state.round = 1;
  state.myRoll = null;
  state.hasRolled = false;
  state.players = {};
  state.enemies = {};

  localStorage.setItem(LS_NICKNAME, safeNickname);
  localStorage.setItem(LS_ROOM, safeRoom);
  localStorage.setItem(LS_IS_GM, state.isGM ? '1' : '0');

  state.players[state.userId] = {
    id: state.userId,
    nickname: safeNickname,
    isGM: state.isGM,
    isEnemy: false,
    hidden: false,
    online: true,
    roll: null,
    staticMod: 0,
    dynamicMod: 0,
    total: null,
    rolledAt: null,
    rolledAtStr: null,
  };

  showGameScreen();

  try {
    await connectRealtime(safeRoom);
  } catch (err) {
    console.error('Supabase error:', err);
    showToast('⚠️ Modo offline: Supabase não configurado ou indisponível.', 'error', 6000);
    addLog('Modo local ativo (Supabase não configurado).', 'gm');
  }

  addLog(`Você entrou na sala "${safeRoom}" como ${state.isGM ? 'Mestre' : 'Jogador'}.`, 'join');
  renderPlayersGrid();
}

async function leaveRoom() {
  if (channel) {
    try {
      await channel.untrack();
      await channel.unsubscribe();
    } catch (err) {
      console.error('Erro ao desconectar do canal:', err);
    }
    channel = null;
  }
  state.players = {};
  state.enemies = {};
  state.myRoll = null;
  state.hasRolled = false;
  logLines.length = 0;
  showLoginScreen();
}

// ──────────────────────────────────────────────────────────────
//  CONTROLE DE TELAS
// ──────────────────────────────────────────────────────────────
function showGameScreen() {
  document.getElementById('screen-login').classList.add('hidden');
  document.getElementById('screen-game').classList.remove('hidden');

  document.getElementById('header-room').textContent = `#${state.room}`;
  document.getElementById('sidebar-room').textContent = state.room;

  if (state.isGM) {
    document.getElementById('btn-next-round').classList.remove('hidden');
    document.getElementById('btn-clear-rolls').classList.remove('hidden');
    document.getElementById('btn-gm-panel').classList.remove('hidden');
  }

  document.getElementById('fab-log').classList.remove('hidden');
  updateMyStatusBar();
}

function showLoginScreen() {
  document.getElementById('screen-game').classList.add('hidden');
  document.getElementById('screen-login').classList.remove('hidden');
}

// ──────────────────────────────────────────────────────────────
//  VERIFICAÇÃO DA CONFIGURAÇÃO SUPABASE (TELA DE LOGIN)
// ──────────────────────────────────────────────────────────────
function checkSupabaseConfig() {
  const el = document.getElementById('supabase-status');
  if (!el) return;
  const configured =
    SUPABASE_URL && !SUPABASE_URL.includes('COLE_AQUI') && SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.includes('COLE_AQUI');

  el.innerHTML = configured
    ? '<span class="text-muted" style="color:var(--color-success);">✓ Supabase configurado — Multiplayer ativo</span>'
    : `<span class="text-muted" style="color:var(--color-ember-light);">
         ⚠️ Supabase não configurado — Modo local (1 jogador)<br>
         <span style="font-size:0.68rem;">Veja o arquivo SETUP.md para configurar</span>
       </span>`;
}

// ──────────────────────────────────────────────────────────────
//  INICIALIZAÇÃO — EVENT LISTENERS
// ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkSupabaseConfig();

  // Preenche campos a partir do localStorage (conveniência, não dados sensíveis)
  const savedNick = localStorage.getItem(LS_NICKNAME) ?? '';
  const savedRoom = localStorage.getItem(LS_ROOM) ?? '';
  const savedGM = localStorage.getItem(LS_IS_GM) === '1';
  document.getElementById('input-nickname').value = savedNick;
  document.getElementById('input-room').value = savedRoom || 'sala-padrao';
  document.getElementById('checkbox-gm').checked = savedGM;

  // ── Formulário de login ──
  document.getElementById('form-login').addEventListener('submit', (e) => {
    e.preventDefault();
    const nick = document.getElementById('input-nickname').value;
    const room = document.getElementById('input-room').value;
    const isGM = document.getElementById('checkbox-gm').checked;
    enterRoom(nick, room, isGM);
  });

  // ── Botão Rolar ──
  document.getElementById('btn-roll').addEventListener('click', rollDiceClicked);

  // ── Modal de modificador dinâmico ──
  document.getElementById('btn-modifier-cancel').addEventListener('click', closeModifierModal);
  document.getElementById('btn-modifier-confirm').addEventListener('click', confirmModifierModal);
  document.getElementById('input-modifier').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmModifierModal();
  });
  document.getElementById('modal-modifier').addEventListener('click', (e) => {
    if (e.target.id === 'modal-modifier') closeModifierModal();
  });

  // ── Botões do GM: rodada e limpeza ──
  document.getElementById('btn-next-round').addEventListener('click', () => {
    if (state.isGM) broadcastNextRound();
  });
  document.getElementById('btn-clear-rolls').addEventListener('click', () => {
    if (!state.isGM) return;
    if (!confirm('Limpar todas as iniciativas desta rodada?')) return;
    broadcastClearRolls();
  });

  // ── Painel do GM (perfis de inimigos) ──
  document.getElementById('btn-gm-panel').addEventListener('click', openGmPanel);
  document.getElementById('btn-gm-close').addEventListener('click', closeGmPanel);
  document.getElementById('modal-gm').addEventListener('click', (e) => {
    if (e.target.id === 'modal-gm') closeGmPanel();
  });

  document.getElementById('form-enemy').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('input-enemy-name').value;
    const mod = document.getElementById('input-enemy-mod').value;
    const hidden = document.getElementById('checkbox-enemy-stealth').checked;
    createEnemyProfile(name, mod, hidden);
    document.getElementById('form-enemy').reset();
  });

  // Delegação de evento para os botões "Rolar"/"Remover" da lista de inimigos
  // (a lista é reconstruída dinamicamente, então não dá para colar listener fixo por item)
  document.getElementById('enemy-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'roll-enemy') startEnemyRoll(id);
    if (btn.dataset.action === 'delete-enemy') deleteEnemyProfile(id);
  });

  // ── Sair da sala ──
  document.getElementById('btn-leave').addEventListener('click', leaveRoom);

  // ── Log: limpar e modal mobile ──
  document.getElementById('btn-clear-log').addEventListener('click', () => {
    logLines.length = 0;
    renderLog();
  });
  document.getElementById('fab-log').addEventListener('click', () => {
    document.getElementById('modal-log').classList.remove('hidden');
  });
  document.getElementById('btn-modal-log-close').addEventListener('click', () => {
    document.getElementById('modal-log').classList.add('hidden');
  });
  document.getElementById('modal-log').addEventListener('click', (e) => {
    if (e.target.id === 'modal-log') document.getElementById('modal-log').classList.add('hidden');
  });

  // ── Modal NAT 20/1 ──
  document.getElementById('btn-modal-close').addEventListener('click', closeNatModal);
  document.getElementById('modal-nat').addEventListener('click', (e) => {
    if (e.target.id === 'modal-nat') closeNatModal();
  });

  // ── Atalho de teclado: Espaço para rolar (fora de inputs) ──
  document.addEventListener('keydown', (e) => {
    const gameVisible = !document.getElementById('screen-game').classList.contains('hidden');
    const modalsOpen = !document.getElementById('modal-modifier').classList.contains('hidden')
      || !document.getElementById('modal-gm').classList.contains('hidden')
      || !document.getElementById('modal-nat').classList.contains('hidden');
    if (e.code === 'Space' && gameVisible && !modalsOpen && !e.target.matches('input,textarea,button')) {
      e.preventDefault();
      rollDiceClicked();
    }
  });
});
