'use strict';

// ── State ─────────────────────────────────────────────────────────────
let selectedSerial      = '';
let selectedPort        = '';
let agentConnected      = false;
let _wusbdEnableOrig    = null;   // 포트 열 때 읽은 원래 WUSBDENABLE 값
const _devicePortMap    = {};     // serial → port (IMEI 매칭 결과)
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

    socket.on('device_update', (d) => { if (selectedPort) applyDeviceList(d.list); });
    socket.on('port_update',   (d) => applyPortList(d.ports, d.open));
    socket.on('logcat_line',   (d) => appendLogcat(d.line));
    socket.on('log_line',      (d) => appendLogLine(d));
    socket.on('remote_control_ack',    (d) => applyRemoteControlState(d));
    socket.on('remote_control_result', (d) => rcShowResult(d));
    socket.on('remote_cmd',            (d) => rcExecuteCmd(d));
    socket.on('log_upload_result',     (d) => onLogUploadResult(d));
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
  // 시리얼 포트가 열려 있으면 ADB 원복 후 닫기
  const port = selectedPort;
  if (port) {
    const restoreVal = (_wusbdEnableOrig !== null) ? _wusbdEnableOrig : 3;
    await sendCommand({ type: 'at_command', port, command: 'AT!UNLOCK=2,"W353"', timeout: 5 });
    await sendCommand({ type: 'at_command', port, command: `AT*WUSBDENABLE=${restoreVal}`, timeout: 5 });
    await sendCommand({ type: 'at_close', port });
  }

  // 상태 초기화
  selectedPort        = '';
  selectedSerial      = '';
  _wusbdEnableOrig    = null;
  Object.keys(_devicePortMap).forEach(k => delete _devicePortMap[k]);
  logRunning          = false;
  kmsgRunning         = false;
  _stopKmsgPoll();

  await fetch('/api/logout', { method: 'POST' });
  currentUser  = null;
  currentPerms = [];
  agentConnected = false;
  applyPermissions();
  showLogin();
  document.getElementById('user-label').textContent        = '';
  document.getElementById('device-list').innerHTML         =
    '<span class="dim-text">시리얼 포트를 먼저 연결하세요</span>';
  document.getElementById('port-status').textContent       = '';
  document.getElementById('at-port-display').textContent   = '미연결';
  document.getElementById('port-select').value             = '';

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
  const allTabs = ['adb-info', 'diag', 'at', 'adb-shell', 'logs', 'kmsg', 'remote', 'guide'];
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

// ── Remote Control ────────────────────────────────────────────────────
let _rcActive       = false;
let _rcRequestTimer = null;

function _rcSetRequestingUI(requesting) {
  const reqBtn  = document.getElementById('rc-request-btn');
  const stopBtn = document.getElementById('rc-stop-btn');
  if (requesting) {
    reqBtn.disabled      = true;
    reqBtn.textContent   = '원격 제어 요청 중...';
    stopBtn.style.display = '';
  } else {
    reqBtn.disabled      = false;
    reqBtn.textContent   = '▶ 원격 제어 요청';
    stopBtn.style.display = 'none';
  }
}

function applyRemoteControlState(d) {
  _rcActive = !!d.active;

  // 요청 타이머 중지
  if (_rcRequestTimer) {
    clearInterval(_rcRequestTimer);
    _rcRequestTimer = null;
  }

  const dot     = document.getElementById('rc-dot');
  const text    = document.getElementById('rc-status-text');
  const bar     = document.getElementById('rc-status-bar');
  const reqBtn  = document.getElementById('rc-request-btn');
  const endBtn  = document.getElementById('rc-end-btn');

  if (_rcActive) {
    dot.className        = 'status-dot ok';
    text.textContent     = '원격 제어 활성';
    bar.className        = 'rc-status connected';
    _rcSetRequestingUI(false);
    reqBtn.style.display = 'none';
    endBtn.style.display = '';
    rcAppend('[시스템] 원격 제어가 활성화됐습니다.', 't-ok');
  } else {
    dot.className        = 'status-dot';
    text.textContent     = '비활성';
    bar.className        = 'rc-status disconnected';
    _rcSetRequestingUI(false);
    reqBtn.style.display = '';
    endBtn.style.display = 'none';
    if (d.error) rcAppend('[오류] ' + d.error, 't-err');
  }
}

function rcRequest() {
  if (_rcActive || _rcRequestTimer) return;
  _rcSetRequestingUI(true);
  rcAppend('[시스템] 원격 제어 요청 중...', 't-dim');
  socket.emit('remote_control_request');
  _rcRequestTimer = setInterval(function() {
    if (!_rcActive) {
      rcAppend('[시스템] 재요청 중...', 't-dim');
      socket.emit('remote_control_request');
    }
  }, 5000);
}

function rcStopRequest() {
  if (_rcRequestTimer) {
    clearInterval(_rcRequestTimer);
    _rcRequestTimer = null;
  }
  _rcSetRequestingUI(false);
  rcAppend('[시스템] 요청이 중지됐습니다.', 't-dim');
}

function rcEnd() {
  socket.emit('remote_control_end');
}

function rcClear() {
  var el = document.getElementById('term-remote');
  if (el) el.textContent = '';
}

function rcAppend(line, cls) {
  var el = document.getElementById('term-remote');
  if (!el) return;
  var span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = line;
  el.appendChild(span);
  el.appendChild(document.createTextNode('\n'));
  el.scrollTop = el.scrollHeight;
}

function rcShowResult(d) {
  if (d.cmd) rcAppend((d.cmd_type === 'adb_shell' ? '$ ' : '> ') + d.cmd, 't-cmd');
  if (d.stdout)   rcAppend(stripAnsi(d.stdout).replace(/\r/g, '').trimEnd(), '');
  if (d.stderr)   rcAppend(stripAnsi(d.stderr).replace(/\r/g, '').trimEnd(), 't-err');
  if (d.response) rcAppend(stripAnsi(d.response), '');
  if (!d.success && d.error) rcAppend('[오류] ' + d.error, 't-err');
}

async function rcExecuteCmd(data) {
  var type = data.type;
  var cmd  = data.command || '';
  var id   = data.id;

  var result;
  if (type === 'at_command') {
    if (!selectedPort) {
      result = { success: false, error: 'AT 포트가 연결되지 않았습니다.' };
    } else {
      result = await sendCommand({ type: 'at_command', port: selectedPort,
                                   command: cmd, timeout: data.timeout || 10 });
    }
  } else if (type === 'adb_shell') {
    if (!selectedSerial) {
      result = { success: false, error: 'ADB 디바이스가 선택되지 않았습니다.' };
    } else {
      result = await sendCommand({ type: 'adb_shell', serial: selectedSerial, command: cmd });
    }
  } else {
    result = { success: false, error: '알 수 없는 명령 타입: ' + type };
  }

  // cmd/type을 포함해서 전송 → 서버가 브로드캐스트 → rcShowResult에서 한 번만 표시
  socket.emit('remote_result', Object.assign({}, result, { id: id, cmd: cmd, cmd_type: type }));
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
      '<span class="dim-text">시리얼 포트를 먼저 연결하세요</span>';
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
  if (!selectedPort) { toast('시리얼 포트를 먼저 연결하세요.', true); return; }
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

  // 현재 포트에 매칭된 단말기만 표시
  const filtered = (list || []).filter(d => _devicePortMap[d.serial] === selectedPort);

  if (filtered.length === 0) {
    el.innerHTML = '<span class="dim-text">매칭된 장치 없음</span>';
    if (selectedSerial && _devicePortMap[selectedSerial] !== selectedPort) selectedSerial = '';
    return;
  }

  // 매칭 단말기 자동 선택
  const matched = filtered.find(d => d.status === 'device');
  if (matched && selectedSerial !== matched.serial) {
    selectedSerial = matched.serial;
  }

  el.innerHTML = filtered.map(d => `
    <div class="device-item ${d.serial === selectedSerial ? 'selected' : ''}"
         onclick="selectDevice('${d.serial}','${d.status}')">
      <div class="d-serial">${d.serial}</div>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="badge ${d.status === 'device' ? 'green' : 'red'}">${d.status}</span>
        <button class="btn-sm danger" style="padding:1px 7px;font-size:10px;line-height:16px"
                onclick="event.stopPropagation();closeDevice('${d.serial}')">닫기</button>
      </div>
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

async function closeDevice(serial) {
  if (!selectedPort) { toast('시리얼 포트가 연결되지 않았습니다.', true); return; }
  const restoreVal = (_wusbdEnableOrig !== null) ? _wusbdEnableOrig : 3;

  document.getElementById('device-list').innerHTML =
    '<span class="dim-text">ADB 닫는 중...</span>';

  await sendCommand({ type: 'at_command', port: selectedPort,
                      command: 'AT!UNLOCK=2,"W353"', timeout: 5 });
  await sendCommand({ type: 'at_command', port: selectedPort,
                      command: `AT*WUSBDENABLE=${restoreVal}`, timeout: 5 });

  if (selectedSerial === serial) selectedSerial = '';
  delete _devicePortMap[serial];
  toast(`${serial} ADB 닫기 (WUSBDENABLE=${restoreVal})`);

  // 디바이스 disconnect 대기 후 목록 갱신
  document.getElementById('device-list').innerHTML =
    '<span class="dim-text">상태 확인 중...</span>';
  await new Promise(resolve => setTimeout(resolve, 2000));
  refreshDevices();
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
  if (parsed.dhcpStart) rows.push(row('IP 범위', `${parsed.dhcpStart} ~ ${parsed.dhcpEnd}`));
  if (parsed.dhcpMask)  rows.push(row('서브넷 마스크', parsed.dhcpMask));
  if (parsed.dhcpLease) rows.push(row('임대 시간', fmtLease(parsed.dhcpLease)));
  if (parsed.dns)       rows.push(row('DNS 서버', parsed.dns));

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

async function uploadLogs() {
  if (!selectedSerial) { toast('디바이스를 먼저 선택하세요.', true); return; }
  const btn    = document.getElementById('log-upload-btn');
  const status = document.getElementById('log-upload-status');
  btn.disabled    = true;
  btn.textContent = '수집 중...';
  status.textContent = '로그 수집 중 (dmesg, /data/logs/*, /var/log/messages) ...';

  const res = await sendCommand({ type: 'log_upload', serial: selectedSerial, port: selectedPort }, 'log_upload');
  if (!res.success) {
    toast(res.error || '업로드 요청 실패', true);
    btn.disabled    = false;
    btn.textContent = '⬆ 로그 업로드';
    status.textContent = '';
    return;
  }
  // 수집은 백그라운드에서 진행 중 — log_upload_result 이벤트로 완료 통보
  status.textContent = '서버로 전송 중...';
}

function onLogUploadResult(d) {
  const btn    = document.getElementById('log-upload-btn');
  const status = document.getElementById('log-upload-status');
  btn.disabled    = false;
  btn.textContent = '⬆ 로그 업로드';
  if (d.success) {
    const warn = d.errors && d.errors.length
      ? `  (실패 ${d.errors.length}개)` : '';
    toast(`로그 업로드 완료: ${d.count}개 파일 저장${warn}`);
    status.textContent = `✓ 저장 위치: ${d.path}  (${d.count}개 파일)${warn}`;
  } else {
    toast('업로드 실패: ' + (d.error || '알 수 없는 오류'), true);
    status.textContent = '';
  }
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
  if (!res.success) { toast(res.message || res.error || '오류', true); return; }

  selectedPort = port;
  document.getElementById('at-port-display').textContent = port;
  toast(res.message);
  sendCommand({ type: 'at_ports' }, 'refresh_ports').then(r => {
    if (r.success !== false) applyPortList(r.data, r.open);
  });

  // AT 초기화 시퀀스
  const deviceEl = document.getElementById('device-list');
  deviceEl.innerHTML = '<span class="dim-text">AT 초기화 중...</span>';

  const unlockRes = await sendCommand({ type: 'at_command', port, command: 'AT!UNLOCK=2,"W353"', timeout: 5 });
  if (!(unlockRes.response || '').includes('OK')) {
    deviceEl.innerHTML = '<span class="dim-text">UNLOCK 실패 — 장치를 확인하세요</span>';
    return;
  }

  const usbRes = await sendCommand({ type: 'at_command', port, command: 'AT*WUSBDENABLE?', timeout: 5 });
  const match  = (usbRes.response || '').match(/\*WUSBDENABLE\s*[=:]\s*(\d+)/i);
  if (match) {
    const val = parseInt(match[1], 10);
    _wusbdEnableOrig = val;   // 원래 값 저장
    if (val !== 0 && val !== 1) {
      await sendCommand({ type: 'at_command', port, command: 'AT*WUSBDENABLE=0', timeout: 5 });
    }
  }

  deviceEl.innerHTML = '<span class="dim-text">연결 중...</span>';
  await new Promise(function(resolve) { setTimeout(resolve, 3000); });

  // IMEI 매칭 (최대 5회 시도)
  const MAX_MATCH = 5;
  let matchRes = null;
  for (let attempt = 1; attempt <= MAX_MATCH; attempt++) {
    deviceEl.innerHTML =
      `<span class="dim-text">연결 중... (${attempt}/${MAX_MATCH})</span>`;

    // 디바이스 목록 갱신
    const devRes = await sendCommand({ type: 'adb_devices' }, 'refresh_devices');

    // IMEI 매칭 시도
    matchRes = await sendCommand({ type: 'at_match_device', port }, 'at_match');
    if (matchRes.success && matchRes.serial) {
      Object.keys(_devicePortMap).forEach(s => { if (_devicePortMap[s] === port) delete _devicePortMap[s]; });
      _devicePortMap[matchRes.serial] = port;
      selectedSerial = matchRes.serial;
      if (devRes.success) applyDeviceList(devRes.data);
      toast(`${port} ↔ ${matchRes.serial} 자동 매칭 (${attempt}회 시도)`);
      break;
    }

    if (attempt < MAX_MATCH) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  if (!matchRes || !matchRes.success) {
    deviceEl.innerHTML = '<span class="dim-text">매칭 실패 — 단말기 연결을 확인하세요</span>';
    toast('IMEI 매칭 실패 (5회 시도)', true);
  }
}

async function closePort() {
  const port = selectedPort || document.getElementById('port-select').value;
  if (!port) { toast('닫을 포트가 없습니다.', true); return; }

  // 닫기 전 AT 시퀀스
  await sendCommand({ type: 'at_command', port, command: 'AT!UNLOCK=2,"W353"', timeout: 5 });
  await sendCommand({ type: 'at_command', port, command: 'AT*WUSBDENABLE=3', timeout: 5 });

  const res = await sendCommand({ type: 'at_close', port });
  if (res.success) {
    // 이 포트에 매칭된 단말기 매핑 제거
    Object.keys(_devicePortMap).forEach(s => { if (_devicePortMap[s] === port) delete _devicePortMap[s]; });
    if (selectedPort === port) {
      selectedPort = '';
      document.getElementById('at-port-display').textContent = '미연결';
    }
    document.getElementById('device-list').innerHTML =
      '<span class="dim-text">시리얼 포트를 먼저 연결하세요</span>';
    selectedSerial = '';
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

// ── 자동 점검 ─────────────────────────────────────────────────────────

const DIAG_STEPS = [
  { id: 'imei',    label: 'IMEI 확인' },
  { id: 'phone',   label: 'PHONE 번호 확인' },
  { id: 'usim',    label: 'USIM 인식' },
  { id: 'rmnet',   label: 'RMNET_DATA IP 확인' },
  { id: 'bridge0', label: 'BRIDGE0 인터페이스 확인' },
];

function _diagBuildTable() {
  const tbody = document.getElementById('diag-rows');
  tbody.innerHTML = '';
  DIAG_STEPS.forEach(step => {
    const tr = document.createElement('tr');
    tr.id = 'diag-row-' + step.id;
    tr.style.cssText = 'border-bottom:1px solid var(--border)';
    tr.innerHTML =
      '<td style="padding:10px 8px;width:24px;text-align:center;font-size:15px">' +
        '<span class="diag-dot" style="color:var(--text-dim)">○</span>' +
      '</td>' +
      '<td style="padding:10px 12px;color:var(--text);white-space:nowrap">' + step.label + '</td>' +
      '<td style="padding:10px 8px;color:var(--text-dim)" class="diag-msg">—</td>';
    tbody.appendChild(tr);
  });
  const v = document.getElementById('diag-verdict');
  v.style.display = 'none';
  v.textContent   = '';
  document.getElementById('diag-overall').textContent = '';
}

function _diagSetRow(id, state, text) {
  const row = document.getElementById('diag-row-' + id);
  if (!row) return;
  const dot  = row.querySelector('.diag-dot');
  const msg  = row.querySelector('.diag-msg');
  const MAP  = {
    pending: { icon: '○', color: 'var(--text-dim)' },
    running: { icon: '⟳', color: 'var(--blue)' },
    ok:      { icon: '✓', color: 'var(--green)' },
    fail:    { icon: '✗', color: 'var(--red)' },
  };
  const s = MAP[state] || MAP.pending;
  dot.textContent = s.icon;
  dot.style.color = s.color;
  if (text !== undefined) {
    msg.textContent = text;
    msg.style.color = state === 'fail' ? 'var(--red)'
                    : state === 'ok'   ? 'var(--green)'
                    : 'var(--text-dim)';
  }
}

function _diagVerdict(ok, msg) {
  const v = document.getElementById('diag-verdict');
  v.style.display    = 'block';
  v.style.background = ok ? 'rgba(80,200,120,0.12)' : 'rgba(220,80,80,0.12)';
  v.style.color      = ok ? 'var(--green)' : 'var(--red)';
  v.style.border     = '1px solid ' + (ok ? 'var(--green)' : 'var(--red)');
  v.textContent      = msg;
  document.getElementById('diag-overall').textContent = ok ? '✓ 정상' : '✗ 이상 감지';
  document.getElementById('diag-overall').style.color = ok ? 'var(--green)' : 'var(--red)';
}

async function runDiag() {
  if (!selectedSerial) { toast('디바이스를 먼저 선택하세요.', true); return; }
  if (!selectedPort)   { toast('시리얼 포트를 먼저 연결하세요.', true); return; }

  const btn = document.getElementById('diag-run-btn');
  btn.disabled = true;
  document.getElementById('diag-overall').textContent = '점검 중...';
  document.getElementById('diag-overall').style.color = 'var(--text-dim)';
  _diagBuildTable();

  const fail = (id, msg, verdict) => {
    _diagSetRow(id, 'fail', msg);
    _diagVerdict(false, verdict || msg);
    btn.disabled = false;
  };

  // ── 1. IMEI ────────────────────────────────────────────────────────
  _diagSetRow('imei', 'running', '확인 중...');
  const imeiRes = await sendCommand(
    { type: 'adb_shell', serial: selectedSerial, command: 'cat /var/tmp/imei' }, 'diag');
  const imei = (imeiRes.stdout || '').trim();
  if (!imeiRes.success || !imei || /^0+$/.test(imei) || imei.length < 10) {
    return fail('imei', 'IMEI 정보 오류', 'IMEI 정보 오류 — 점검 중단');
  }
  _diagSetRow('imei', 'ok', imei);

  // ── 2. PHONE 번호 ──────────────────────────────────────────────────
  _diagSetRow('phone', 'running', '확인 중...');
  const phoneRes = await sendCommand(
    { type: 'adb_shell', serial: selectedSerial, command: 'cat /var/tmp/phone_number' }, 'diag');
  const phone = (phoneRes.stdout || '').trim().replace(/\D/g, '');
  if (!phoneRes.success || !/^0(10|12)\d{7,8}$/.test(phone)) {
    return fail('phone', '번호 정보 오류', '번호 정보 오류 — 점검 중단');
  }
  _diagSetRow('phone', 'ok', phone);

  // ── 3. USIM 상태 ──────────────────────────────────────────────────
  _diagSetRow('usim', 'running', '확인 중...');
  const usimRes = await sendCommand(
    { type: 'at_command', port: selectedPort, command: 'AT*WSTAT?', timeout: 5 }, 'diag');
  const usimResp = (usimRes.response || '').toUpperCase();
  if (usimResp.includes('READY')) {
    _diagSetRow('usim', 'ok', 'READY');
  } else if (usimResp.includes('OPEN')) {
    return fail('usim', '미개통', '미개통 — 점검 중단');
  } else {
    return fail('usim', 'USIM 오류', 'USIM 오류 — 점검 중단');
  }

  // ── 4. RMNET IP ────────────────────────────────────────────────────
  _diagSetRow('rmnet', 'running', '확인 중...');
  const ipRes = await sendCommand(
    { type: 'at_command', port: selectedPort, command: 'AT*WWANIP?', timeout: 5 }, 'diag');
  const ipResp  = ipRes.response || '';
  const v4match = ipResp.match(/V4:\s*(\S+)/i);
  const v6match = ipResp.match(/V6:\s*(\S+)/i);
  const hasV4   = v4match && v4match[1] && !/^0\.0\.0\.0$/.test(v4match[1]) && v4match[1] !== '-';
  const hasV6   = v6match && v6match[1] && v6match[1] !== '::' && v6match[1] !== '-';
  if (!hasV4 && !hasV6) {
    return fail('rmnet', '무선망 NETWORK 연결 오류', '무선망 NETWORK 연결 오류 — 점검 중단');
  }
  const ipInfo = [hasV4 ? 'V4 ' + v4match[1] : '', hasV6 ? 'V6 ' + v6match[1] : '']
                  .filter(Boolean).join('  ');
  _diagSetRow('rmnet', 'ok', ipInfo);

  // ── 5. BRIDGE0 인터페이스 ─────────────────────────────────────────
  _diagSetRow('bridge0', 'running', '확인 중...');
  const ifRes = await sendCommand(
    { type: 'adb_shell', serial: selectedSerial, command: 'ifconfig' }, 'diag');
  if (!ifRes.success || !(ifRes.stdout || '').includes('bridge0')) {
    return fail('bridge0', '네트워크 인터페이스 오류', '네트워크 인터페이스 오류 — 점검 중단');
  }
  _diagSetRow('bridge0', 'ok', '확인됨');

  // ── 전체 통과 ─────────────────────────────────────────────────────
  _diagVerdict(true, '✓ 모든 항목 정상');
  btn.disabled = false;
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
