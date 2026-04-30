'use strict';

// ── State ─────────────────────────────────────────────────────────────
let selectedSerial  = '';
let selectedPort    = '';
let agentConnected  = false;
let logRunning      = false;
let kmsgRunning     = false;
let _kmsgPollTimer  = null;
const KMSG_POLL_MS  = 5000;
let _toastTimer     = null;
let currentUser     = null;
let currentPerms    = [];

const adbHistory = [], atHistory = [];
let adbHistIdx = -1, atHistIdx = -1;

const _pending = {};
let _cmdSeq = 0;

// ── Socket (DOMContentLoaded 이후 초기화 - io 로드 실패 시 함수 정의 보호) ──
let socket = null;

// ── Init ──────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // socket.io 초기화
  try {
    socket = io({ transports: ['websocket'], reconnection: true });

    socket.on('connect', () => {
      socket.emit('browser_hello');
    });

    socket.on('agent_status', (d) => {
      agentConnected = d.connected;
      if (d.username && !currentUser) {
        currentUser  = d.username;
        currentPerms = d.permissions || [];
        applyPermissions();
        hideLogin();
      }
      updateAgentUI(d);
      if (d.connected) {
        refreshDevices();
        refreshPorts();
      }
    });

    socket.on('result', (data) => {
      const { id } = data;
      if (id && _pending[id]) {
        _pending[id](data);
        delete _pending[id];
      }
    });

    socket.on('device_update', (d) => applyDeviceList(d.list));
    socket.on('port_update',   (d) => applyPortList(d.ports, d.open));
    socket.on('logcat_line',   (d) => appendLogcat(d.line));
    socket.on('log_line',      (d) => appendLogLine(d));
  } catch (e) {
    console.error('Socket.IO 초기화 실패:', e);
    toast('Socket.IO 로드 실패. 페이지를 새로고침하세요.', true);
  }

  fetch('/api/me')
    .then(r => {
      if (!r.ok) throw new Error('unauth');
      return r.json();
    })
    .then(me => {
      currentUser  = me.username;
      currentPerms = me.permissions || [];
      applyPermissions();
      hideLogin();
    })
    .catch(() => showLogin());

  fetch('/api/server-info').then(r => r.json()).then(info => {
    const exeBtn       = document.getElementById('btn-download-exe');
    const bannerExeBtn = document.getElementById('banner-btn-exe');
    if (!info.exe_ready) {
      [exeBtn, bannerExeBtn].forEach(b => {
        if (!b) return;
        b.textContent  = '⬇ agent.exe (미빌드)';
        b.title        = 'build_agent.bat 실행 후 dist/agent.exe를 서버에 복사하세요.';
        b.style.opacity = '0.5';
      });
    }
  }).catch(() => {});
});

// ── Login / Logout ────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('login-overlay').style.display = 'flex';
}
function hideLogin() {
  document.getElementById('login-overlay').style.display = 'none';
  const label = document.getElementById('user-label');
  if (label) label.textContent = currentUser ? `👤 ${currentUser}` : '';
}

async function doLogin() {
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  const errEl    = document.getElementById('login-error');
  errEl.style.display = 'none';

  if (!username || !password) {
    errEl.textContent   = '사용자명과 비밀번호를 입력하세요.';
    errEl.style.display = 'block';
    return;
  }

  const res = await fetch('/api/login', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) {
    errEl.textContent   = data.error || '로그인 실패';
    errEl.style.display = 'block';
    return;
  }

  currentUser  = data.username;
  currentPerms = data.permissions || [];
  applyPermissions();
  hideLogin();
  document.getElementById('login-pass').value = '';
  // 로그인 후 소켓 재연결 → 새 세션 쿠키로 handshake
  if (socket) {
    socket.disconnect();
    socket.connect();
  }
}

async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  currentUser  = null;
  currentPerms = [];
  agentConnected = false;
  applyPermissions();
  showLogin();
  document.getElementById('user-label').textContent = '';
  // 로그아웃 후 소켓 재연결 → 세션 초기화 반영
  if (socket) {
    socket.disconnect();
    socket.connect();
  }
}

// ── Permissions ───────────────────────────────────────────────────────
function hasPermission(perm) {
  return currentPerms.includes(perm);
}

function applyPermissions() {
  const allTabs = ['adb-info', 'at', 'adb-shell', 'logs', 'kmsg', 'guide'];
  allTabs.forEach(tabId => {
    const el = document.querySelector(`.tab[data-tab="${tabId}"]`);
    if (el) el.style.display = hasPermission(tabId) ? '' : 'none';
  });

  applyGuidePermissions();

  // 첫 번째 접근 가능한 탭으로 이동
  const first = allTabs.find(t => hasPermission(t));
  if (first) switchTab(first);
}

function applyGuidePermissions() {
  const isAdmin = ['adb-shell', 'adb-info', 'at', 'logs', 'kmsg', 'guide']
    .every(p => hasPermission(p));

  // data-guide-perm: 해당 권한이 있을 때만 표시
  document.querySelectorAll('[data-guide-perm]').forEach(el => {
    el.style.display = hasPermission(el.dataset.guidePerm) ? '' : 'none';
  });

  // data-guide-admin: admin(전체 권한)일 때만 표시
  document.querySelectorAll('[data-guide-admin]').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
}

// ── Command helper ────────────────────────────────────────────────────
function sendCommand(cmd, tag) {
  return new Promise((resolve) => {
    if (!agentConnected) {
      toast('에이전트가 연결되지 않았습니다.', true);
      resolve({ success: false, error: 'no agent' });
      return;
    }
    const id = `${tag || 'cmd'}-${++_cmdSeq}`;
    _pending[id] = resolve;
    socket.emit('command', { ...cmd, id });
    setTimeout(() => {
      if (_pending[id]) {
        delete _pending[id];
        resolve({ success: false, error: 'timeout' });
      }
    }, 60000);
  });
}

// ── Agent UI ──────────────────────────────────────────────────────────
function updateAgentUI(d) {
  const dot    = document.getElementById('agent-dot');
  const text   = document.getElementById('agent-text');
  const bar    = document.getElementById('agent-bar');
  const banner = document.getElementById('setup-banner');

  if (d.connected) {
    dot.className    = 'status-dot ok';
    text.textContent = `에이전트 연결됨${d.info?.node ? ' · ' + d.info.node : ''}`;
    bar.className    = 'agent-bar connected';
    if (banner) banner.style.display = 'none';
  } else {
    dot.className    = 'status-dot';
    text.textContent = '에이전트 미연결';
    bar.className    = 'agent-bar disconnected';
    if (banner) banner.style.display = 'flex';
    document.getElementById('device-list').innerHTML =
      '<span class="dim-text">에이전트 연결 대기 중</span>';
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────
function switchTab(id) {
  // 현재 활성 탭이 kmsg이고 다른 탭으로 이동하면 폴링 중지
  const prevTab = document.querySelector('.tab.active')?.dataset.tab;
  if (prevTab === 'kmsg' && id !== 'kmsg') {
    _stopKmsgPoll();
  }

  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === id));
  document.querySelectorAll('.panel').forEach(p =>
    p.classList.toggle('active', p.id === `panel-${id}`));

  if (id === 'at') {
    document.getElementById('at-port-display').textContent = selectedPort || '미연결';
  }

  // kmsg 탭 진입 시 실행 중이면 즉시 새로고침 + 폴링 재개
  if (id === 'kmsg' && kmsgRunning) {
    _startKmsgPoll();
  }
}

// ── Refresh helpers ───────────────────────────────────────────────────
function refreshDevices() {
  sendCommand({ type: 'adb_devices' }, 'refresh_devices').then(r => {
    if (r.success) applyDeviceList(r.data);
  });
}

function refreshPorts() {
  sendCommand({ type: 'at_ports' }, 'refresh_ports').then(r => {
    if (r.success) applyPortList(r.data, r.open);
  });
}

// ── ADB ───────────────────────────────────────────────────────────────
function applyDeviceList(list) {
  const el = document.getElementById('device-list');
  if (!list || list.length === 0) {
    el.innerHTML = '<span class="dim-text">연결된 장치 없음</span>';
    selectedSerial = '';
    return;
  }

  // 장치가 하나만 있으면 자동 선택
  if (list.length === 1 && list[0].status === 'device') {
    const d = list[0];
    if (selectedSerial !== d.serial) {
      selectedSerial = d.serial;
      toast(`자동 선택: ${d.serial}`);
    }
  }

  el.innerHTML = list.map(d => `
    <div class="device-item ${d.serial === selectedSerial ? 'selected' : ''}"
         onclick="selectDevice('${d.serial}','${d.status}')">
      <div class="d-serial">${d.serial}</div>
      <div><span class="badge ${d.status === 'device' ? 'green' : 'red'}">${d.status}</span></div>
      ${d.info ? `<div class="d-info">${d.info}</div>` : ''}
    </div>`).join('');
}

function selectDevice(serial, status) {
  selectedSerial = serial;
  document.querySelectorAll('.device-item').forEach(el =>
    el.classList.toggle('selected',
      el.querySelector('.d-serial')?.textContent === serial));
  appendLine('term-adb', `# 디바이스 선택: ${serial} (${status})`, 't-dim');
  toast(`선택: ${serial}`);
}

async function runAdbShell() {
  const input = document.getElementById('adb-input');
  const cmd   = input.value.trim();
  if (!cmd) return;
  if (!selectedSerial) { toast('디바이스를 먼저 선택하세요.', true); return; }
  pushHistory(adbHistory, cmd); adbHistIdx = -1; input.value = '';

  appendLine('term-adb', `$ ${cmd}`, 't-cmd');
  const res = await sendCommand({ type: 'adb_shell', serial: selectedSerial, command: cmd });
  if (res.stdout) appendText('term-adb', res.stdout, res.success ? '' : 't-err');
  if (res.stderr) appendText('term-adb', res.stderr, 't-err');
  if (!res.stdout && !res.stderr && res.success) appendLine('term-adb', '(출력 없음)', 't-dim');
  if (res.error)  appendLine('term-adb', res.error, 't-err');
}

// ── Device Info Sections ──────────────────────────────────────────────

// 섹션 ID → 로더 함수 매핑
const SECTION_LOADERS = {
  'sec-at':       () => _fetchSectionAt(),
  'sec-ifconfig': () => _fetchSectionShell('sec-ifconfig', 'ifconfig'),
  'sec-dns':      () => _fetchSectionDns(),
  'sec-mem':      () => _fetchSectionShell('sec-mem', 'cat /proc/meminfo'),
  'sec-ps':       () => _fetchSectionShell('sec-ps', 'ps'),
};

// 헤더 클릭: 열 때 데이터 로드, 닫을 때는 그냥 닫기
function toggleSection(secId) {
  const body  = document.getElementById(secId);
  const arrow = document.getElementById(`arrow-${secId}`);
  if (!body) return;
  const opening = body.style.display === 'none';
  body.style.display = opening ? '' : 'none';
  if (arrow) arrow.textContent = opening ? '▼' : '▶';
  if (opening && SECTION_LOADERS[secId]) {
    SECTION_LOADERS[secId]();
  }
}

// 새로고침 버튼: 열고 + 데이터 다시 로드
function refreshSection(secId) {
  const body  = document.getElementById(secId);
  const arrow = document.getElementById(`arrow-${secId}`);
  if (body) body.style.display = '';
  if (arrow) arrow.textContent = '▼';
  if (SECTION_LOADERS[secId]) SECTION_LOADERS[secId]();
}

function _setPreContent(preId, html) {
  const el = document.getElementById(preId);
  if (el) el.innerHTML = html;
}

function _setPreText(preId, text) {
  const el = document.getElementById(preId);
  if (el) el.textContent = text.replace(/\r/g, '').trimEnd();
}

async function _fetchSectionShell(secId, cmd) {
  if (!selectedSerial) { toast('디바이스를 먼저 선택하세요.', true); return; }
  _setPreContent(`pre-${secId}`, '<span class="dim-text">읽는 중...</span>');
  const res = await sendCommand({ type: 'adb_shell', serial: selectedSerial, command: cmd });
  if (res.success && res.stdout) {
    _setPreText(`pre-${secId}`, res.stdout);
  } else {
    const msg = res.stderr || res.error || '오류가 발생했습니다.';
    _setPreContent(`pre-${secId}`, `<span class="t-err">${escapeHtml(msg)}</span>`);
  }
}

async function _fetchSectionAt() {
  if (!selectedPort) {
    _setPreContent('pre-sec-at', '<span class="t-warn">AT 포트를 먼저 열어주세요. (좌측 사이드바)</span>');
    return;
  }
  _setPreContent('pre-sec-at', '<span class="dim-text">읽는 중...</span>');
  const timeout = 10;
  const lines   = [];
  const r1 = await sendCommand({ type: 'at_command', port: selectedPort, command: 'AT$$DBS', timeout });
  lines.push('▶ AT$$DBS');
  lines.push(r1.response || r1.error || '(응답 없음)');
  lines.push('');
  const r2 = await sendCommand({ type: 'at_command', port: selectedPort, command: 'AT+CGDCONT?', timeout });
  lines.push('▶ AT+CGDCONT?');
  lines.push(r2.response || r2.error || '(응답 없음)');
  _setPreText('pre-sec-at', lines.join('\n'));
}

function _renderDnsmasqConf(raw) {
  const parsed = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t.startsWith('dhcp-range=')) {
      const parts = t.slice('dhcp-range='.length).split(',');
      if (parts.length >= 4) {
        const hasIface = isNaN(parts[0].charAt(0));
        if (hasIface) {
          [parsed.dhcpIface, parsed.dhcpStart, parsed.dhcpEnd, parsed.dhcpMask, parsed.dhcpLease]
            = [parts[0], parts[1], parts[2], parts[3], parts[4] || ''];
        } else {
          [parsed.dhcpStart, parsed.dhcpEnd, parsed.dhcpMask, parsed.dhcpLease]
            = [parts[0], parts[1], parts[2], parts[3]];
        }
      }
    } else if (t.startsWith('dhcp-option-force=6,')) {
      parsed.dns = t.slice('dhcp-option-force=6,'.length).trim();
    } else if (t.startsWith('dhcp-option-force=26,')) {
      parsed.mtu = t.slice('dhcp-option-force=26,'.length).trim();
    }
  }

  function fmtLease(s) {
    const n = parseInt(s, 10);
    if (isNaN(n)) return s;
    if (n >= 86400) return `${Math.round(n / 86400)}일 (${n}초)`;
    if (n >= 3600)  return `${Math.round(n / 3600)}시간 (${n}초)`;
    if (n >= 60)    return `${Math.round(n / 60)}분 (${n}초)`;
    return `${n}초`;
  }

  function row(label, value) {
    return `<tr><td class="dns-label">${label}</td><td class="dns-value">${escapeHtml(value)}</td></tr>`;
  }

  const rows = [];
  if (parsed.dhcpIface) rows.push(row('인터페이스', parsed.dhcpIface));
  if (parsed.dhcpStart) rows.push(row('IP 범위', `${parsed.dhcpStart} ~ ${parsed.dhcpEnd}`));
  if (parsed.dhcpMask)  rows.push(row('서브넷 마스크', parsed.dhcpMask));
  if (parsed.dhcpLease) rows.push(row('임대 시간', fmtLease(parsed.dhcpLease)));
  if (parsed.dns)       rows.push(row('DNS 서버', parsed.dns));
  if (parsed.mtu)       rows.push(row('MTU', `${parsed.mtu} bytes`));

  const summary = rows.length
    ? `<table class="dns-table">${rows.join('')}</table>`
    : '<span class="dim-text">파싱 가능한 항목 없음</span>';

  return `<div class="dns-summary">${summary}</div>`;
}

async function _fetchSectionDns() {
  if (!selectedSerial) { toast('디바이스를 먼저 선택하세요.', true); return; }
  _setPreContent('pre-sec-dns', '<span class="dim-text">읽는 중...</span>');
  const r = await sendCommand({ type: 'adb_shell', serial: selectedSerial,
    command: 'cat /var/run/data/dnsmasq.conf.bridge0' });
  if (!r.success) {
    _setPreContent('pre-sec-dns', `<span class="t-err">${escapeHtml(r.error || '오류')}</span>`);
    return;
  }
  const text = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '');
  _setPreContent('pre-sec-dns', _renderDnsmasqConf(text));
}

// 전체 새로고침: 열려 있는 섹션만 다시 로드
async function loadAllDeviceInfo() {
  if (!selectedSerial) { toast('디바이스를 먼저 선택하세요.', true); return; }
  const statusEl = document.getElementById('info-status');
  if (statusEl) statusEl.textContent = '읽는 중...';
  await Promise.all(Object.keys(SECTION_LOADERS).map(id => SECTION_LOADERS[id]()));
  if (statusEl) statusEl.textContent = '완료';
  setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
}

// 하위 호환용 (index.html onclick에서 직접 호출)
function loadSectionShell(secId, cmd) { return _fetchSectionShell(secId, cmd); }
function loadSectionAt()               { return _fetchSectionAt(); }

// ── Logs tab ──────────────────────────────────────────────────────────
async function startLog() {
  if (!selectedSerial) { toast('디바이스를 먼저 선택하세요.', true); return; }
  if (logRunning) await stopLog();
  const path = document.getElementById('log-source').value;
  const res  = await sendCommand({ type: 'log_start', serial: selectedSerial, path });
  if (res.success) {
    logRunning = true;
    document.getElementById('log-status').textContent = `▶ ${path}`;
  } else {
    toast(res.error || '로그 시작 실패', true);
  }
}

async function stopLog() {
  await sendCommand({ type: 'log_stop' });
  logRunning = false;
  document.getElementById('log-status').textContent = '■ 정지';
}

async function downloadLog(path, filename) {
  if (!selectedSerial) { toast('디바이스를 먼저 선택하세요.', true); return; }
  toast(`${filename} 읽는 중...`);
  const res = await sendCommand({ type: 'log_get', serial: selectedSerial, path }, 'log_get');
  if (!res.success) { toast(res.error || '파일 읽기 실패', true); return; }
  _downloadText(res.data || '', filename + '.log');
}

// ── kmsg tab ──────────────────────────────────────────────────────────
function _startKmsgPoll() {
  _stopKmsgPoll();
  _fetchKmsg();                                          // 즉시 1회 실행
  _kmsgPollTimer = setInterval(_fetchKmsg, KMSG_POLL_MS); // 이후 주기적 실행
}

function _stopKmsgPoll() {
  if (_kmsgPollTimer) {
    clearInterval(_kmsgPollTimer);
    _kmsgPollTimer = null;
  }
}

async function _fetchKmsg() {
  if (!selectedSerial || !kmsgRunning) return;
  const res = await sendCommand({ type: 'kmsg_get', serial: selectedSerial }, 'kmsg_poll');
  if (res.success && res.data) {
    const term = document.getElementById('term-kmsg');
    if (term) {
      term.textContent = res.data.replace(/\r/g, '').trimEnd();
      autoScroll(term);
    }
    const ts = new Date().toLocaleTimeString();
    document.getElementById('kmsg-status').textContent = `▶ 실행 중  (갱신: ${ts})`;
  }
}

function startKmsg() {
  if (!selectedSerial) { toast('디바이스를 먼저 선택하세요.', true); return; }
  kmsgRunning = true;
  document.getElementById('kmsg-status').textContent = '▶ 실행 중';
  _startKmsgPoll();
}

function stopKmsg() {
  kmsgRunning = false;
  _stopKmsgPoll();
  document.getElementById('kmsg-status').textContent = '■ 정지';
}

async function downloadKmsg() {
  if (!selectedSerial) { toast('디바이스를 먼저 선택하세요.', true); return; }
  toast('kmsg 읽는 중...');
  const res = await sendCommand({ type: 'kmsg_get', serial: selectedSerial }, 'kmsg_get');
  if (!res.success) { toast(res.error || 'kmsg 읽기 실패', true); return; }
  _downloadText(res.data || '', 'kmsg.log');
}

function appendLogLine(d) {
  const source = d.source || 'log';
  const termId = source === 'kmsg' ? 'term-kmsg' : 'term-logs';
  const term   = document.getElementById(termId);
  if (!term) return;
  const div = document.createElement('div');
  div.textContent = d.line;
  term.appendChild(div);
  autoScroll(term);
}

// ── AT Command ────────────────────────────────────────────────────────
function applyPortList(ports, open) {
  const sel = document.getElementById('port-select');
  const cur = sel.value;
  sel.innerHTML = '<option value="">포트 선택</option>' +
    (ports || []).map(p =>
      `<option value="${p.port}" ${open?.includes(p.port) ? 'style="color:var(--green)"' : ''}>` +
      `${p.port} — ${p.description}</option>`
    ).join('');
  if (cur) sel.value = cur;
  document.getElementById('port-status').textContent =
    open?.length ? `열린 포트: ${open.join(', ')}` : '';
}

async function openPort() {
  const port     = document.getElementById('port-select').value;
  const baudrate = document.getElementById('baud-select').value;
  if (!port) { toast('포트를 선택하세요.', true); return; }
  const res = await sendCommand({ type: 'at_open', port, baudrate: parseInt(baudrate) });
  if (res.success) {
    selectedPort = port;
    document.getElementById('at-port-display').textContent = port;
    toast(res.message);
    sendCommand({ type: 'at_ports' }, 'refresh_ports').then(r => {
      if (r.success !== false) applyPortList(r.data, r.open);
    });
  } else {
    toast(res.message || res.error || '오류', true);
  }
}

async function closePort() {
  const port = selectedPort || document.getElementById('port-select').value;
  if (!port) { toast('닫을 포트가 없습니다.', true); return; }
  const res = await sendCommand({ type: 'at_close', port });
  if (res.success) {
    if (selectedPort === port) {
      selectedPort = '';
      document.getElementById('at-port-display').textContent = '미연결';
    }
    toast(res.message);
    sendCommand({ type: 'at_ports' }, 'refresh_ports').then(r => {
      if (r.success !== false) applyPortList(r.data, r.open);
    });
  } else {
    toast(res.message || res.error || '오류', true);
  }
}

async function runAtCommand() {
  const input = document.getElementById('at-input');
  let cmd = input.value.trim();
  if (!cmd) return;
  if (!selectedPort) { toast('포트를 먼저 열어주세요.', true); return; }
  if (!cmd.toUpperCase().startsWith('AT')) cmd = 'AT' + cmd;
  pushHistory(atHistory, cmd); atHistIdx = -1; input.value = '';

  const timeout = parseFloat(document.getElementById('at-timeout').value) || 5;
  appendLine('term-at', `▶ ${cmd}`, 't-cmd');
  const res = await sendCommand({ type: 'at_command', port: selectedPort, command: cmd, timeout });
  if (res.success) {
    appendText('term-at', res.response, res.response?.includes('ERROR') ? 't-err' : 't-ok');
  } else {
    appendLine('term-at', res.response || res.error || '오류', 't-err');
  }
}

// ── Terminal helpers ──────────────────────────────────────────────────
function appendLine(termId, text, cls = '') {
  const term = document.getElementById(termId);
  if (!term) return;
  const div  = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  term.appendChild(div);
  autoScroll(term);
}

function stripAnsi(s) {
  return (s || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function appendText(termId, text, cls = '') {
  stripAnsi(text).trimEnd().split('\n').forEach(l => appendLine(termId, l, cls));
}

function appendLogcat(line) {
  // logcat는 현재 사용하지 않지만 하위호환 유지
  appendLine('term-logs', line);
}

function clearTerm(termId) {
  const el = document.getElementById(termId);
  if (el) el.innerHTML = '';
}
function autoScroll(el) { el.scrollTop = el.scrollHeight; }

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── File download helper ──────────────────────────────────────────────
function _downloadText(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Keyboard history ──────────────────────────────────────────────────
function handleKey(e, type) {
  if (e.key === 'Enter') { type === 'adb' ? runAdbShell() : runAtCommand(); return; }
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  const history = type === 'adb' ? adbHistory : atHistory;
  const inputId = type === 'adb' ? 'adb-input' : 'at-input';
  let   idx     = type === 'adb' ? adbHistIdx  : atHistIdx;
  if (e.key === 'ArrowUp')   idx = Math.min(idx + 1, history.length - 1);
  if (e.key === 'ArrowDown') idx = Math.max(idx - 1, -1);
  if (type === 'adb') adbHistIdx = idx; else atHistIdx = idx;
  document.getElementById(inputId).value = idx >= 0 ? history[idx] : '';
}

function pushHistory(arr, cmd) {
  if (arr[0] !== cmd) arr.unshift(cmd);
  if (arr.length > 100) arr.pop();
}

// ── Toast ─────────────────────────────────────────────────────────────
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent       = msg;
  el.style.borderColor = isError ? 'var(--red)'  : 'var(--border)';
  el.style.color       = isError ? 'var(--red)'  : 'var(--text)';
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}
