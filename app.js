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
const AVATAR_URL_MAX_LEN = 500;
const LS_LAST_MODIFIER = 'rpg_initiative_last_modifier'; // 🔄 persistência do bônus (item 3)

let supabaseClient = null;
let channel = null;

// 🔧 CORREÇÃO "Background Disconnect": rastreiam o estado da conexã o
// Realtime para a lógica de reconexão via Visibility API.
let isRealtimeConnected = false;
let currentRoomName = null; // nome da sala atual, necessário para reconectar
let reconnectInFlight = false; // evita reconexões simultâneas duplicadas

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
  avatarUrl: null, // URL pública (link externo) da foto de perfil, null = usa iniciais
  lastModifier: null, // 🔄 ITEM 3: último bônus situacional digitado pelo jogador (string crua)
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

/**
 * Gera os atributos HTML (class + style) para um círculo de avatar,
 * usando a foto de perfil quando disponível ou caindo de volta para
 * o gradiente de iniciais. Centralizado aqui para que TODOS os pontos
 * de renderização (card, sala de espera, status bar, header) fiquem
 * consistentes — evita ter essa lógica duplicada em 4 lugares.
 */
/**
 * Gera os atributos/HTML interno para um círculo de avatar.
 * 🖼️ MUDANÇA: agora usa um elemento <img> real (com object-fit: cover)
 * em vez de background-image. Vantagens práticas:
 *   1) object-fit: cover centraliza e corta a imagem sem distorcer,
 *      exatamente como pedido, com tamanho sempre fixo pelo círculo pai;
 *   2) o atributo onerror do <img> nos dá um fallback NATIVO do
 *      navegador: se o link público estiver quebrado/expirado, o
 *      avatar cai sozinho para as iniciais, sem JS extra de verificação.
 * Centralizado aqui para que todos os pontos de renderização (card,
 * sala de espera, status bar, header) fiquem consistentes.
 */
function avatarVisual(displayName, avatarUrl) {
  const safeName = sanitizeText(displayName) || '?';
  if (avatarUrl) {
    // 🔒 Escapa a URL antes de injetar em atributo HTML.
    const safeUrl = escapeHtml(avatarUrl);
    const fallbackInitials = escapeHtml(initials(safeName));
    // onerror: troca o próprio <img> pelas iniciais em caso de link
    // inválido/expirado — usa replaceWith para nunca deixar um ícone
    // de imagem quebrada visível ao jogador.
    const innerHtml = `<img src="${safeUrl}" alt="${escapeHtml(safeName)}" class="avatar-img" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${fallbackInitials}',className:'avatar-fallback-text'}))" />`;
    return { className: 'avatar-circle has-photo', styleExtra: '', label: '', innerHtml };
  }
  const colors = colorFromString(safeName);
  const label = initials(safeName);
  return {
    className: 'avatar-circle',
    styleExtra: `background:linear-gradient(135deg, ${colors[0]}, ${colors[1]});`,
    label,
    innerHtml: escapeHtml(label),
  };
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
  reroll: 'log-msg-reroll',
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
      const displayName = resolveDisplayName(p);
      const av = avatarVisual(displayName, p.avatarUrl);
      return `
        <div class="waiting-chip">
          <div class="${av.className}" style="${av.styleExtra}">${av.innerHtml}</div>
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
  // 🖼️ Inimigos em Modo Furtivo nunca expõem a foto real do perfil do
  // inimigo para jogadores comuns — junto com o nome, a foto também
  // cai para o avatar genérico de iniciais ("IO") quando ocultos.
  const avatarUrlForDisplay = player.isEnemy && player.hidden && !state.isGM ? null : player.avatarUrl;
  const av = avatarVisual(displayName, avatarUrlForDisplay);
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
          <div class="${av.className}" style="${av.styleExtra}">${av.innerHtml}</div>
          <span class="status-dot ${player.online ? 'online' : 'offline'}"></span>
        </div>
        <div class="card-name-block">
          <div class="card-name-row">
            <span class="card-name">${escapeHtml(displayName)}</span>
            ${isMe ? '<span class="card-tag card-tag-me">EU</span>' : ''}
            ${player.isGM ? '<span class="card-tag card-tag-gm">GM</span>' : ''}
            ${player.isEnemy ? '<span class="card-tag card-tag-enemy">Inimigo</span>' : ''}
            ${hasRolled && player.isReroll ? '<span class="card-tag card-tag-reroll">🔁 Re-roll</span>' : ''}
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
              ? `<div class="dice-value ${rClass}${state.isGM ? ' gm-editable' : ''}" ${state.isGM ? `data-action="edit-initiative" data-id="${player.id}" title="Clique para editar a iniciativa (GM)"` : ''}>${player.total}</div>
                 <div class="roll-caption ${rClass === 'nat20' ? 'crit' : rClass === 'nat1' ? 'fail' : ''}">
                   ${player.manualOverride ? '✏️ Editado pelo Mestre' : rClass === 'nat20' ? '⚔️ CRÍTICO NATURAL!' : rClass === 'nat1' ? '💀 FALHA CRÍTICA!' : 'Total de Iniciativa'}
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

  const myAvatar = avatarVisual(state.nickname, state.avatarUrl);
  [document.getElementById('my-avatar-sm'), document.getElementById('header-avatar')].forEach((el) => {
    if (!el) return;
    el.innerHTML = myAvatar.innerHtml;
    el.className = el.id === 'my-avatar-sm' ? `${myAvatar.className} avatar-sm` : myAvatar.className;
    el.setAttribute('style', myAvatar.styleExtra);
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

/**
 * 🔄 ITEM 3: lê o último bônus situacional usado pelo jogador, com
 * fallback em cascata: state em memória (mais rápido, válido durante
 * a sessão atual) → localStorage (sobrevive a um refresh de página).
 * Guardamos como STRING (não número) para preservar exatamente o que
 * o jogador digitou, incluindo o caso de campo vazio.
 */
function getLastModifierValue() {
  if (state.lastModifier !== null && state.lastModifier !== undefined) return state.lastModifier;
  try {
    const stored = localStorage.getItem(LS_LAST_MODIFIER);
    return stored !== null ? stored : '';
  } catch {
    return ''; // localStorage pode estar bloqueado (modo privado, etc.)
  }
}

function saveLastModifierValue(value) {
  state.lastModifier = value;
  try {
    localStorage.setItem(LS_LAST_MODIFIER, value);
  } catch {
    // Falha silenciosa: se localStorage estiver indisponível, a
    // persistência ainda funciona durante a sessão via state em memória.
  }
}

function openModifierModal(context) {
  state.pendingModifierContext = context;
  const input = document.getElementById('input-modifier');
  // 🔄 ITEM 3: pré-popula com o último bônus usado, mas SÓ para
  // rolagens do próprio jogador — rolagens de inimigo (GM) sempre
  // começam vazias, já que cada monstro tende a ter um modificador
  // situacional diferente e não devem herdar o bônus pessoal do GM.
  input.value = context?.type === 'player_roll' ? getLastModifierValue() : '';
  document.getElementById('modal-modifier').classList.remove('hidden');
  setTimeout(() => input?.focus(), 50);
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
    // 🔄 ITEM 3: persiste exatamente o que foi digitado (string crua),
    // para o campo continuar mostrando "2" e não "2.0" ou algo do tipo,
    // e para preservar um campo vazio como "vazio" na próxima rolagem.
    saveLastModifierValue(raw);
    executePlayerRoll(dynamicMod, !!context.isReroll);
  } else if (context.type === 'enemy_roll') {
    executeEnemyRoll(context.enemyId, dynamicMod);
  }
}

// ──────────────────────────────────────────────────────────────
//  MODAL: CONFIRMAÇÃO DE RE-ROLL
// ──────────────────────────────────────────────────────────────
function openRerollModal() {
  document.getElementById('modal-reroll').classList.remove('hidden');
}

function closeRerollModal() {
  document.getElementById('modal-reroll').classList.add('hidden');
}

function confirmReroll() {
  closeRerollModal();
  // Após confirmar o re-roll, segue o fluxo normal de rolagem
  // (incluindo o modal de modificador situacional), apenas marcando
  // o contexto como re-roll para que o resultado final saiba disso.
  openModifierModal({ type: 'player_roll', isReroll: true });
}

// ──────────────────────────────────────────────────────────────
//  ROLAGEM DO JOGADOR
// ──────────────────────────────────────────────────────────────
function rollDiceClicked() {
  if (!state.nickname) return;
  // 🔒 TRAVA: impede que o usuário abra dois modais/disparos simultâneos
  // clicando rápido duas vezes (mini race condition local no cliente).
  if (rollInFlight) return;

  // 🔄 ALTERAÇÃO A: o bloqueio de nova rolagem foi removido. Se o
  // jogador já rolou nesta rodada, pedimos confirmação explícita de
  // re-roll em vez de simplesmente impedir a ação.
  if (state.hasRolled) {
    openRerollModal();
    return;
  }
  openModifierModal({ type: 'player_roll', isReroll: false });
}

async function executePlayerRoll(dynamicMod, isReroll = false) {
  if (rollInFlight) return;
  rollInFlight = true;

  const btn = document.getElementById('btn-roll');
  // 🔒 Trava apenas MOMENTÂNEA (evita duplo-clique durante o processamento
  // desta rolagem) — não impede mais rolagens futuras, já que o re-roll
  // agora é permitido. O botão é sempre reabilitado no `finally` abaixo.
  btn.disabled = true;

  try {
    const me = state.players[state.userId];
    const staticMod = me?.staticMod ?? 0;
    const roll = rollDie(DICE_MAX);
    const total = roll + staticMod + dynamicMod;
    const timestamp = Date.now();

    state.hasRolled = true;
    state.myRoll = roll;
    applyRollToPlayer(state.userId, { roll, staticMod, dynamicMod, total, rolledAt: timestamp, rolledAtStr: nowTime(), isReroll });

    renderPlayersGrid();
    animateCard(state.userId, roll);
    announceRollLocally(state.nickname, roll, staticMod, dynamicMod, total, isReroll);

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
      isReroll,
    });

    // 🔧 CORREÇÃO BUG 1: além do broadcast (que só quem já está
    // conectado recebe em tempo real), atualizamos nossa entrada de
    // Presence com o resultado da rolagem. Assim, qualquer jogador
    // que entrar na sala DEPOIS deste momento ainda consegue ver essa
    // rolagem ao sincronizar o presenceState, em vez de só receber
    // eventos futuros.
    if (channel) {
      await channel.track({
        userId: state.userId,
        nickname: state.nickname,
        isGM: state.isGM,
        avatarUrl: state.avatarUrl,
        lastRoll: getMyLastRollPayload(),
        joinedAt: Date.now(),
      });
    }
  } finally {
    rollInFlight = false;
    btn.disabled = false; // 🔄 sempre reabilita: re-roll deve continuar disponível
  }
}

/**
 * 🔄 ITEM 2 (melhoria no log): formata o detalhamento de uma rolagem
 * incluindo o bônus situacional/estático quando presente, no formato
 * "D20: 18 (+3) = 21". Sem nenhum modificador, simplifica para apenas
 * "D20: 18" (já que aí o roll e o total são o mesmo número, repetir
 * seria redundante e poluiria o log).
 */
function formatRollBreakdown(roll, staticMod, dynamicMod, total) {
  const totalMod = (staticMod ?? 0) + (dynamicMod ?? 0);
  if (totalMod === 0) return `D20: ${roll}`;
  const sign = totalMod > 0 ? '+' : ''; // números negativos já trazem o "-" embutido
  return `D20: ${roll} (${sign}${totalMod}) = ${total}`;
}

function announceRollLocally(nickname, roll, staticMod, dynamicMod, total, isReroll = false) {
  const safeName = sanitizeText(nickname) || 'Alguém';
  // 🔄 ALTERAÇÃO A: prefixo obrigatório de re-roll, usado tanto no toast
  // quanto no log de combate — nenhum dos dois pode omitir essa informação.
  const rerollTag = isReroll ? '🔁 [RE-ROLL] ' : '';
  const breakdown = formatRollBreakdown(roll, staticMod, dynamicMod, total);
  if (roll === DICE_MAX) {
    showToast(`${rerollTag}⚔️ ${safeName} tirou NAT 20! CRÍTICO!`, 'nat20', 5000);
    showNatModal({ isNat20: true, playerNick: safeName, value: roll });
  } else if (roll === 1) {
    showToast(`${rerollTag}💀 ${safeName} falhou criticamente!`, 'error', 4000);
    showNatModal({ isNat20: false, playerNick: safeName, value: roll });
  } else {
    showToast(`${rerollTag}🎲 ${safeName} rolou ${breakdown}`, 'info', 2500);
  }
  const logType = roll === DICE_MAX ? 'nat20' : roll === 1 ? 'nat1' : isReroll ? 'reroll' : 'default';
  const rerollLogPrefix = isReroll ? '[RE-ROLL] ' : '';
  addLog(`${rerollLogPrefix}${safeName} rolou ${breakdown}${roll === DICE_MAX ? ' — CRÍTICO!' : roll === 1 ? ' — FALHA!' : ''}`, logType);
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
      isReroll: false,
      avatarUrl: typeof payload.avatarUrl === 'string' ? payload.avatarUrl : null,
      manualOverride: false, // 🆕 true quando o GM editou o total manualmente
    };
  }
  const p = state.players[userId];
  p.roll = safeInt(payload.roll, 0, 1, DICE_MAX);
  p.staticMod = safeInt(payload.staticMod, 0, MODIFIER_MIN, MODIFIER_MAX);
  p.dynamicMod = safeInt(payload.dynamicMod, 0, MODIFIER_MIN, MODIFIER_MAX);
  p.total = safeInt(payload.total, p.roll + p.staticMod + p.dynamicMod, -999, 999);
  p.rolledAt = payload.rolledAt ?? Date.now();
  p.rolledAtStr = sanitizeText(payload.rolledAtStr) || nowTime();
  p.isReroll = !!payload.isReroll;
  // 🆕 Uma rolagem de dado "de verdade" (manual ou via re-roll) sempre
  // limpa qualquer edição manual anterior do GM — o novo resultado é
  // legítimo e não deve continuar marcado como "editado pelo Mestre".
  p.manualOverride = false;
  if (payload.hidden !== undefined) p.hidden = !!payload.hidden;
  // Só sobrescreve avatarUrl se o payload trouxe explicitamente um valor
  // (rolagens não recarregam a foto a cada vez; presence sync é quem
  // mantém isso atualizado quando o jogador troca de foto no meio do jogo).
  if (payload.avatarUrl !== undefined) p.avatarUrl = typeof payload.avatarUrl === 'string' ? payload.avatarUrl : null;
}

/**
 * 🔧 CORREÇÃO BUG 1 (late join): devolve o último resultado de
 * rolagem do PRÓPRIO jogador, no mesmo formato aceito por
 * applyRollToPlayer. Esse objeto é incluído no payload do Presence
 * (channel.track), para que qualquer pessoa que entre na sala DEPOIS
 * da rolagem consiga recuperá-la a partir do presenceState atual —
 * sem precisar de nenhuma tabela no banco, já que o Presence já
 * mantém e propaga o estado de quem está conectado no momento.
 * Retorna null se o jogador ainda não rolou nesta rodada.
 */
function getMyLastRollPayload() {
  const me = state.players[state.userId];
  if (!me || me.roll === null || me.roll === undefined) return null;
  return {
    roll: me.roll,
    staticMod: me.staticMod,
    dynamicMod: me.dynamicMod,
    total: me.total,
    rolledAt: me.rolledAt,
    rolledAtStr: me.rolledAtStr,
    isReroll: me.isReroll,
    round: state.round,
  };
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

  const displayName = profile.hidden ? 'Inimigo Oculto' : profile.name;
  const breakdown = formatRollBreakdown(roll, profile.staticMod, dynamicMod, total);
  addLog(`${state.isGM ? 'GM' : 'Alguém'} rolou iniciativa para ${displayName}: ${breakdown}`, roll === DICE_MAX ? 'nat20' : roll === 1 ? 'nat1' : 'gm');

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

/**
 * 🆕 NOVA FUNCIONALIDADE: revela todos os inimigos em Modo Furtivo,
 * tanto os perfis reutilizáveis (state.enemies — afeta futuras
 * rolagens) quanto as instâncias já presentes na lista de iniciativa
 * (state.players — afeta o que está visível AGORA para os jogadores).
 * 🔒 Mantém o nome real do inimigo intacto durante toda a operação —
 * só alteramos a flag `hidden`, então nada precisa ser "descoberto"
 * ou recriado, apenas a visibilidade muda.
 */
function applyRevealEnemies() {
  let revealedCount = 0;

  Object.values(state.enemies).forEach((enemy) => {
    if (enemy.hidden) {
      enemy.hidden = false;
      revealedCount++;
    }
  });

  Object.values(state.players).forEach((player) => {
    if (player.isEnemy && player.hidden) {
      player.hidden = false;
    }
  });

  renderEnemyList();
  renderPlayersGrid();
  addLog('GM revelou todos os inimigos ocultos.', 'gm');
  showToast(
    revealedCount > 0 || Object.values(state.players).some((p) => p.isEnemy)
      ? '👁️ Inimigos ocultos revelados!'
      : 'Nenhum inimigo estava oculto.',
    'info'
  );
}

async function broadcastRevealEnemies() {
  if (!state.isGM) return;
  applyRevealEnemies();
  if (!channel) return;
  // 🔄 Sincroniza em tempo real: envia o ID + nome real de cada
  // instância de inimigo revelada, para que os clientes dos jogadores
  // (que não têm os perfis do GM em seu state.enemies) consigam
  // atualizar tanto a flag hidden quanto exibir o nome correto.
  const revealedInstances = Object.values(state.players)
    .filter((p) => p.isEnemy)
    .map((p) => ({ userId: p.id, nickname: p.nickname }));
  await channel.send({ type: 'broadcast', event: 'reveal_enemies', payload: { gmId: state.userId, revealedInstances } });
}

// ──────────────────────────────────────────────────────────────
//  EDIÇÃO MANUAL DE INICIATIVA (GM)
// ──────────────────────────────────────────────────────────────

let editingInitiativeUserId = null; // guarda qual card está sendo editado entre abrir e confirmar

function openEditInitiativeModal(userId) {
  const player = state.players[userId];
  if (!player || player.total === null) return; // 🔒 só edita quem já rolou
  editingInitiativeUserId = userId;

  const displayName = resolveDisplayName(player);
  document.getElementById('edit-initiative-subtext').textContent = `Defina o valor de iniciativa de ${displayName} para a rodada atual.`;
  const input = document.getElementById('input-edit-initiative');
  input.value = player.total;
  document.getElementById('modal-edit-initiative').classList.remove('hidden');
  setTimeout(() => {
    input.focus();
    input.select();
  }, 50);
}

function closeEditInitiativeModal() {
  document.getElementById('modal-edit-initiative').classList.add('hidden');
  editingInitiativeUserId = null;
}

async function confirmEditInitiative() {
  const userId = editingInitiativeUserId;
  const raw = document.getElementById('input-edit-initiative').value;
  closeEditInitiativeModal();
  if (!userId || !state.players[userId]) return;

  // 🔒 TRAVA: campo vazio/inválido cancela a edição em vez de zerar a
  // iniciativa de alguém por acidente (diferente do modificador de
  // rolagem, aqui não existe um "valor neutro" razoável para usar).
  const trimmed = sanitizeText(raw, 10);
  if (trimmed === '') {
    showToast('Edição cancelada: nenhum valor informado.', 'info', 2500);
    return;
  }
  const newTotal = safeInt(raw, null, -999, 999);
  if (newTotal === null) {
    showToast('⚠️ Valor inválido — a iniciativa não foi alterada.', 'error');
    return;
  }

  applyManualInitiativeEdit(userId, newTotal);

  if (channel) {
    await channel.send({
      type: 'broadcast',
      event: 'edit_initiative',
      payload: { userId, total: newTotal, gmId: state.userId },
    });
  }
}

/**
 * 🆕 NOVA FUNCIONALIDADE: aplica a sobrescrita manual do GM no total
 * de iniciativa de um participante (jogador ou inimigo).
 * 🔒 Mantemos roll/staticMod/dynamicMod como estavam — não fazemos
 * "engenharia reversa" do número editado para esses componentes, já
 * que o GM pode estar definindo um valor arbitrário sem relação com
 * um d20 específico (ex: "todos os esqueletos agem na contagem 10").
 * A flag manualOverride é o que avisa a UI para não exibir mais o
 * detalhamento de CRÍTICO/FALHA, que deixaria de fazer sentido.
 */
function applyManualInitiativeEdit(userId, newTotal) {
  const p = state.players[userId];
  if (!p) return;
  const displayName = resolveDisplayName(p);
  p.total = newTotal;
  p.manualOverride = true;
  renderPlayersGrid();
  addLog(`GM ajustou manualmente a iniciativa de ${displayName} para ${newTotal}.`, 'gm');
  showToast(`✏️ Iniciativa de ${displayName} ajustada para ${newTotal}.`, 'info', 2500);
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

  currentRoomName = room; // mantido também aqui por segurança (reconexão chama connectRealtime diretamente)
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
    const p = state.players[payload.userId];
    const roll = p.roll;
    const total = p.total;
    // 🔄 ALTERAÇÃO A: propaga a marcação de re-roll recebida de OUTRO
    // cliente, garantindo que todos os jogadores na sala vejam a mesma
    // informação no log, não só quem executou a ação.
    const isReroll = !!payload.isReroll;
    const rerollTag = isReroll ? '🔁 [RE-ROLL] ' : '';
    // 🔄 ITEM 2: mesmo detalhamento "D20: X (+Y) = Z" usado no log local,
    // agora também para rolagens recebidas de outros jogadores/inimigos.
    const breakdown = formatRollBreakdown(roll, p.staticMod, p.dynamicMod, total);

    if (roll === DICE_MAX) {
      showToast(`${rerollTag}⚔️ ${safeName} tirou NAT 20! CRÍTICO!`, 'nat20', 5000);
      showNatModal({ isNat20: true, playerNick: safeName, value: roll });
    } else if (roll === 1) {
      showToast(`${rerollTag}💀 ${safeName} falhou criticamente!`, 'error', 4000);
    } else {
      showToast(`${rerollTag}🎲 ${safeName} rolou ${breakdown}`, 'info', 2000);
    }
    const logType = roll === DICE_MAX ? 'nat20' : roll === 1 ? 'nat1' : isReroll ? 'reroll' : 'default';
    addLog(`${isReroll ? '[RE-ROLL] ' : ''}${safeName} rolou ${breakdown}${roll === DICE_MAX ? ' — CRÍTICO!' : roll === 1 ? ' — FALHA!' : ''}`, logType);
  });

  channel.on('broadcast', { event: 'next_round' }, ({ payload }) => {
    if (state.isGM) return; // o GM já aplicou localmente antes de transmitir
    applyNextRound(payload?.round);
  });

  channel.on('broadcast', { event: 'reveal_enemies' }, ({ payload }) => {
    if (state.isGM) return; // o GM já aplicou localmente antes de transmitir
    // 🔒 TRAVA: ignora payload malformado (sem array de instâncias).
    const instances = Array.isArray(payload?.revealedInstances) ? payload.revealedInstances : [];
    instances.forEach(({ userId, nickname }) => {
      if (!userId || !state.players[userId]) return;
      state.players[userId].hidden = false;
      // Atualiza também o nome, já que o jogador via apenas "Inimigo
      // Oculto" até agora e nunca recebeu o nome real deste inimigo.
      if (nickname) state.players[userId].nickname = sanitizeText(nickname) || state.players[userId].nickname;
    });
    renderPlayersGrid();
    addLog('O Mestre revelou os inimigos ocultos!', 'gm');
    showToast('👁️ Os inimigos ocultos foram revelados!', 'info', 3000);
  });

  channel.on('broadcast', { event: 'edit_initiative' }, ({ payload }) => {
    if (state.isGM) return; // o GM já aplicou localmente antes de transmitir
    // 🔒 TRAVA: ignora payload malformado ou referência a jogador que
    // este cliente não conhece (ex: chegou fora de ordem).
    const userId = payload?.userId;
    const newTotal = safeInt(payload?.total, null, -999, 999);
    if (!userId || !state.players[userId] || newTotal === null) return;
    applyManualInitiativeEdit(userId, newTotal);
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
        const isNewPlayer = !state.players[uid];

        if (isNewPlayer) {
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
            isReroll: false,
            manualOverride: false,
            avatarUrl: typeof presence.avatarUrl === 'string' ? presence.avatarUrl : null,
          };
        } else {
          state.players[uid].online = true;
          // 🖼️ Mantém a foto de perfil sincronizada mesmo se o jogador
          // trocá-la DEPOIS de já estar na sala (re-track de presence).
          state.players[uid].avatarUrl = typeof presence.avatarUrl === 'string' ? presence.avatarUrl : null;
        }

        // 🔧 CORREÇÃO BUG 1 (late join): se a presença trouxe uma
        // rolagem (lastRoll) DA RODADA ATUAL, aplicamos ela ao
        // registro local — é assim que um jogador que entrou depois
        // das rolagens conseguem ver os resultados já existentes,
        // sem depender de ter "perdido" os eventos de broadcast.
        // 🔒 TRAVA: só aplica se for da rodada atual (round) — evita
        // "ressuscitar" o resultado de uma rodada antiga para alguém
        // que entrou depois do GM já ter avançado o combate. Também só
        // aplica se ainda não temos uma rolagem local mais recente
        // (rolledAt maior), para nunca sobrescrever um re-roll que já
        // recebemos via broadcast com um dado de presence desatualizado.
        const lastRoll = presence.lastRoll;
        if (lastRoll && typeof lastRoll === 'object' && lastRoll.round === state.round) {
          const existing = state.players[uid];
          const incomingIsNewer = !existing.rolledAt || (lastRoll.rolledAt ?? 0) >= existing.rolledAt;
          if (incomingIsNewer) {
            applyRollToPlayer(uid, { ...lastRoll, nickname: presence.nickname, isGM: presence.isGM, avatarUrl: presence.avatarUrl });
          }
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
      isRealtimeConnected = true;
      await channel.track({ userId: state.userId, nickname: state.nickname, isGM: state.isGM, avatarUrl: state.avatarUrl, lastRoll: getMyLastRollPayload(), joinedAt: Date.now() });
      addLog(`Conectado à sala "${room}".`, 'gm');
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      isRealtimeConnected = false;
      showToast('❌ Erro de conexão. Tente novamente em alguns instantes.', 'error', 8000);
    } else if (status === 'CLOSED') {
      // 🔧 CORREÇÃO "Background Disconnect": navegadores mobile costumam
      // fechar conexões WebSocket quando a aba vai para segundo plano
      // (minimizar, trocar de app). Isso chega aqui como CLOSED — não
      // tentamos reconectar imediatamente neste callback (a aba pode
      // estar em background agora mesmo, e reconectar nesse momento é
      // inútil); só marcamos o estado como desconectado. A reconexão de
      // fato é disparada pelo listener de visibilitychange, quando a
      // aba volta a ficar visível — ver setupVisibilityReconnect().
      isRealtimeConnected = false;
    }
  });
}

// ──────────────────────────────────────────────────────────────
//  RECONEXÃO AUTOMÁTICA (BACKGROUND DISCONNECT FIX)
//  Navegadores mobile suspendem ou fecham conexões WebSocket quando a
//  aba vai para segundo plano (usuário minimiza, troca de app, ou o
//  sistema operacional pausa a aba para economizar bateria). Ao voltar,
//  o canal Realtime antigo pode estar morto sem que nenhum evento
//  visível tenha disparado ainda. A Visibility API nos avisa exatamente
//  quando a aba volta a ficar visível, e é o gatilho ideal para
//  verificar a conexão e reconectar se necessário.
// ──────────────────────────────────────────────────────────────

async function reconnectRealtimeChannel() {
  // 🔒 TRAVA: evita reconexões simultâneas (ex: o evento de visibilidade
  // disparando mais de uma vez rapidamente, ou o usuário alternando de
  // app repetidamente antes da primeira reconexão terminar).
  if (reconnectInFlight) return;
  if (!currentRoomName || !state.userId) return; // não está numa sala — nada a reconectar
  if (isRealtimeConnected && channel) return; // já conectado, nada a fazer

  reconnectInFlight = true;
  showToast('🔄 Reconectando...', 'info', 2500);

  try {
    // Descarta o canal antigo (provavelmente já morto) antes de criar um
    // novo — unsubscribe pode falhar se o canal já estiver fechado pelo
    // navegador, então isso é só uma tentativa de limpeza, não crítica.
    if (channel) {
      try {
        await channel.unsubscribe();
      } catch (err) {
        console.error('Falha ao limpar canal antigo (esperado se já estava morto):', err);
      }
      channel = null;
    }

    // 🔧 Reaproveita exatamente a mesma lógica de conexão inicial — ao
    // reconectar, o handler de presence.sync (já implementado para o
    // bug de late-join) automaticamente repovoa o estado de todos os
    // jogadores e suas últimas rolagens a partir do presenceState atual,
    // então não precisamos duplicar nenhuma lógica de sincronização aqui.
    await connectRealtime(currentRoomName);
    showToast('✓ Reconectado!', 'success', 2000);
    addLog('Conexão restabelecida após retornar à aba.', 'gm');
  } catch (err) {
    console.error('Falha ao reconectar:', err);
    showToast('⚠️ Não foi possível reconectar automaticamente. Recarregue a página se o problema persistir.', 'error', 6000);
  } finally {
    reconnectInFlight = false;
  }
}

function setupVisibilityReconnect() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Pequeno delay: dá tempo do navegador finalizar a transição de
      // volta ao foreground antes de checar/abrir conexões de rede —
      // evita disparar a reconexão num estado transitório do sistema.
      setTimeout(reconnectRealtimeChannel, 150);
    }
  });

  // 🔧 Em iOS Safari especificamente, voltar de outro app às vezes
  // dispara 'pageshow' (com persisted=true, indicando retorno do cache
  // de navegação) sem necessariamente passar por visibilitychange da
  // mesma forma — adicionamos esse listener como rede de segurança
  // adicional para esse caso específico.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) setTimeout(reconnectRealtimeChannel, 150);
  });
}

// ──────────────────────────────────────────────────────────────
//  FOTO DE PERFIL (LINK PÚBLICO DE IMAGEM)
//  🔄 MUDANÇA: o upload via Supabase Storage foi removido. Agora o
//  jogador apenas cola a URL pública de uma imagem já hospedada em
//  algum lugar da internet (Imgur, Discord CDN, etc). Isso elimina
//  toda a complexidade de bucket/política de Storage — a foto é só
//  uma string de URL guardada no state e propagada via Presence,
//  exatamente como já fazíamos antes, só que sem o passo de upload.
// ──────────────────────────────────────────────────────────────

function openAvatarModal() {
  document.getElementById('input-avatar-url').value = state.avatarUrl || '';
  setAvatarUploadStatus('', null);
  refreshAvatarUrlPreview();
  document.getElementById('modal-avatar').classList.remove('hidden');
  setTimeout(() => document.getElementById('input-avatar-url')?.focus(), 50);
}

function closeAvatarModal() {
  document.getElementById('modal-avatar').classList.add('hidden');
}

function setAvatarUploadStatus(msg, kind) {
  const el = document.getElementById('avatar-upload-status');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('is-error', 'is-success');
  if (kind === 'error') el.classList.add('is-error');
  if (kind === 'success') el.classList.add('is-success');
}

/**
 * 🔒 VALIDAÇÃO DE URL: aceita apenas http(s) bem formado. Não há como
 * verificar no cliente se a URL realmente aponta para uma imagem válida
 * sem carregá-la (CORS pode bloquear até isso) — por isso o preview ao
 * vivo no próprio modal é a confirmação visual: se a imagem não carregar,
 * o <img> dispara onerror e avisamos o jogador ali mesmo, sem travar o
 * salvamento (a URL pode estar correta mas momentaneamente fora do ar).
 */
function validateAvatarUrl(rawUrl) {
  const url = sanitizeText(rawUrl, AVATAR_URL_MAX_LEN);
  if (!url) return { error: null, url: '' }; // campo vazio = remover foto, sempre válido
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: 'A URL precisa começar com http:// ou https://', url: null };
    }
    return { error: null, url: parsed.href };
  } catch {
    return { error: 'Isso não parece ser uma URL válida.', url: null };
  }
}

function refreshAvatarUrlPreview() {
  const raw = document.getElementById('input-avatar-url').value;
  const { error, url } = validateAvatarUrl(raw);
  const preview = document.getElementById('avatar-preview');
  const saveBtn = document.getElementById('btn-avatar-save');

  if (error) {
    setAvatarUploadStatus(`⚠️ ${error}`, 'error');
    saveBtn.disabled = true;
    return;
  }

  saveBtn.disabled = false;
  const av = avatarVisual(state.nickname, url || null);
  preview.className = `${av.className} avatar-preview`;
  preview.setAttribute('style', av.styleExtra);
  preview.innerHTML = av.innerHtml;

  if (!url) {
    setAvatarUploadStatus('Sem imagem — será usado o avatar de iniciais.', null);
    return;
  }

  // Confirmação extra de carregamento (o <img> já tem fallback via
  // onerror, isto aqui é só para dar feedback textual de sucesso).
  setAvatarUploadStatus('Carregando pré-visualização...', null);
  const tester = new Image();
  tester.onload = () => setAvatarUploadStatus('✓ Imagem encontrada.', 'success');
  tester.onerror = () => setAvatarUploadStatus('⚠️ Não foi possível carregar essa imagem. Verifique o link.', 'error');
  tester.src = url;
}

function saveAvatar() {
  const raw = document.getElementById('input-avatar-url').value;
  const { error, url } = validateAvatarUrl(raw);
  if (error) {
    setAvatarUploadStatus(`⚠️ ${error}`, 'error');
    return;
  }

  state.avatarUrl = url || null;
  if (state.players[state.userId]) state.players[state.userId].avatarUrl = state.avatarUrl;
  updateMyStatusBar();
  renderPlayersGrid();

  // Re-transmite a presença para que os outros jogadores recebam a
  // foto (ou a remoção dela) sem precisar recarregar a página.
  if (channel) {
    channel.track({ userId: state.userId, nickname: state.nickname, isGM: state.isGM, avatarUrl: state.avatarUrl, lastRoll: getMyLastRollPayload(), joinedAt: Date.now() });
  }

  showToast(state.avatarUrl ? '🖼️ Foto de perfil atualizada!' : 'Foto removida — usando iniciais.', state.avatarUrl ? 'success' : 'info', 2500);
  closeAvatarModal();
}

function removeAvatarField() {
  document.getElementById('input-avatar-url').value = '';
  refreshAvatarUrlPreview();
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

  // 🔧 Define ANTES da tentativa de conexão (não dentro de connectRealtime),
  // para que uma falha transitória de rede ao reconectar não "esqueça"
  // qual sala o jogador estava — currentRoomName só deve ser limpo de
  // fato quando o jogador sai deliberadamente da sala (leaveRoom).
  currentRoomName = safeRoom;

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
    isReroll: false,
    manualOverride: false,
    avatarUrl: state.avatarUrl,
  };

  showGameScreen();

  try {
    await connectRealtime(safeRoom);
  } catch (err) {
    console.error('Falha na conexão em tempo real:', err);
    showToast('⚠️ Modo offline: sincronização indisponível.', 'error', 6000);
    addLog('Modo local ativo (sincronização indisponível).', 'gm');
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
  // 🔧 Limpa o estado de conexão para que a reconexão automática via
  // Visibility API (setupVisibilityReconnect) não tente reconectar a
  // uma sala que o jogador saiu deliberadamente.
  isRealtimeConnected = false;
  currentRoomName = null;
  // 🔒 CORREÇÃO BUG A: reset COMPLETO do estado de sessão/identidade.
  // Antes, apenas players/enemies eram limpos — nickname, room, isGM e
  // userId permaneciam "vazando" do login anterior. Isso fazia com que,
  // ao deslogar e entrar de novo SEM dar refresh na página, o estado de
  // GM (e outros dados pessoais) continuasse vivo em memória mesmo após
  // o usuário desmarcar a checkbox de GM na tela de login.
  state.nickname = '';
  state.room = '';
  state.isGM = false;
  state.userId = '';
  state.round = 1;
  state.players = {};
  state.enemies = {};
  state.myRoll = null;
  state.hasRolled = false;
  state.avatarUrl = null;
  state.pendingModifierContext = null;
  // 🔄 ITEM 3: limpa apenas o cache em memória — o valor persistido no
  // localStorage permanece intacto, então o próximo login (mesmo sem
  // refresh) volta a ler o último bônus salvo via getLastModifierValue().
  state.lastModifier = null;
  logLines.length = 0;
  resetGmUI(); // 🔒 esconde explicitamente os botões de GM antes de voltar ao login
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

  // 🔒 CORREÇÃO BUG A: antes, os botões de GM só eram MOSTRADOS quando
  // isGM=true, e nunca explicitamente ESCONDIDOS quando isGM=false. Como
  // o DOM persiste entre logins sem refresh de página, um usuário que
  // entrava como GM e depois entrava de novo como jogador comum ainda
  // via os botões (eles nunca tinham sido re-ocultados). Agora ambos os
  // ramos (true/false) são tratados explicitamente em toda entrada de sala.
  if (state.isGM) {
    document.getElementById('btn-next-round').classList.remove('hidden');
    document.getElementById('btn-clear-rolls').classList.remove('hidden');
    document.getElementById('btn-gm-panel').classList.remove('hidden');
  } else {
    document.getElementById('btn-next-round').classList.add('hidden');
    document.getElementById('btn-clear-rolls').classList.add('hidden');
    document.getElementById('btn-gm-panel').classList.add('hidden');
  }

  document.getElementById('fab-log').classList.remove('hidden');
  updateMyStatusBar();
}

/**
 * Garante que toda a UI exclusiva de GM volte ao estado escondido.
 * Chamada ao deslogar, antes mesmo de qualquer novo login acontecer —
 * assim o DOM nunca fica "no limbo" mostrando controles de GM para
 * quem não tem mais essa permissão na sessão atual.
 */
function resetGmUI() {
  document.getElementById('btn-next-round')?.classList.add('hidden');
  document.getElementById('btn-clear-rolls')?.classList.add('hidden');
  document.getElementById('btn-gm-panel')?.classList.add('hidden');
  document.getElementById('modal-gm')?.classList.add('hidden');
}

function showLoginScreen() {
  document.getElementById('screen-game').classList.add('hidden');
  document.getElementById('screen-login').classList.remove('hidden');
}

// ──────────────────────────────────────────────────────────────
//  VERIFICAÇÃO DA CONEXÃO EM TEMPO REAL (TELA DE LOGIN)
//  🔒 ALTERAÇÃO C: o texto exibido ao jogador nunca cita o nome do
//  provedor (Supabase) — apenas indica se o multiplayer está ativo
//  ou em modo local. A integração em si continua normalmente nos
//  bastidores (ver connectRealtime).
// ──────────────────────────────────────────────────────────────
function checkRealtimeConfig() {
  const el = document.getElementById('connection-status');
  if (!el) return;
  const configured =
    SUPABASE_URL && !SUPABASE_URL.includes('COLE_AQUI') && SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.includes('COLE_AQUI');

  el.innerHTML = configured
    ? '<span class="text-muted" style="color:var(--color-success);">✓ Conexão pronta — Multiplayer ativo</span>'
    : `<span class="text-muted" style="color:var(--color-ember-light);">
         ⚠️ Multiplayer indisponível — Modo local (1 jogador)<br>
         <span style="font-size:0.68rem;">Veja o arquivo SETUP.md para configurar</span>
       </span>`;
}

// ──────────────────────────────────────────────────────────────
//  INICIALIZAÇÃO — EVENT LISTENERS
// ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkRealtimeConfig();
  setupVisibilityReconnect(); // 🔧 correção "Background Disconnect"

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

  // ── Modal de confirmação de re-roll ──
  document.getElementById('btn-reroll-cancel').addEventListener('click', closeRerollModal);
  document.getElementById('btn-reroll-confirm').addEventListener('click', confirmReroll);
  document.getElementById('modal-reroll').addEventListener('click', (e) => {
    if (e.target.id === 'modal-reroll') closeRerollModal();
  });

  // ── Modal de foto de perfil (avatar via link público) ──
  document.getElementById('btn-change-avatar').addEventListener('click', openAvatarModal);
  document.getElementById('btn-avatar-cancel').addEventListener('click', closeAvatarModal);
  document.getElementById('btn-avatar-save').addEventListener('click', saveAvatar);
  document.getElementById('btn-avatar-remove').addEventListener('click', removeAvatarField);
  document.getElementById('input-avatar-url').addEventListener('input', refreshAvatarUrlPreview);
  document.getElementById('input-avatar-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveAvatar();
  });
  document.getElementById('modal-avatar').addEventListener('click', (e) => {
    if (e.target.id === 'modal-avatar') closeAvatarModal();
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
  document.getElementById('btn-reveal-enemies').addEventListener('click', () => {
    if (state.isGM) broadcastRevealEnemies();
  });
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

  // 🆕 Delegação de evento para o clique no número de iniciativa (edição
  // manual pelo GM). O grid é reconstruído a cada render, por isso a
  // delegação no container pai em vez de listener por card individual.
  document.getElementById('players-grid').addEventListener('click', (e) => {
    if (!state.isGM) return; // 🔒 segunda camada de defesa, além do elemento só existir no DOM do GM
    const target = e.target.closest('[data-action="edit-initiative"]');
    if (!target) return;
    openEditInitiativeModal(target.dataset.id);
  });

  document.getElementById('btn-edit-initiative-cancel').addEventListener('click', closeEditInitiativeModal);
  document.getElementById('btn-edit-initiative-confirm').addEventListener('click', confirmEditInitiative);
  document.getElementById('input-edit-initiative').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmEditInitiative();
  });
  document.getElementById('modal-edit-initiative').addEventListener('click', (e) => {
    if (e.target.id === 'modal-edit-initiative') closeEditInitiativeModal();
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
      || !document.getElementById('modal-nat').classList.contains('hidden')
      || !document.getElementById('modal-reroll').classList.contains('hidden')
      || !document.getElementById('modal-avatar').classList.contains('hidden')
      || !document.getElementById('modal-edit-initiative').classList.contains('hidden');
    if (e.code === 'Space' && gameVisible && !modalsOpen && !e.target.matches('input,textarea,button')) {
      e.preventDefault();
      rollDiceClicked();
    }
  });
});
