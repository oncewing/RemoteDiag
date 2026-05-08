'use strict';

// ── State ─────────────────────────────────────────────────────────────
let selectedSerial      = '';
let selectedPort        = '';
let agentConnected      = false;
let _wusbdEnableOrig    = null;   // 포트 열 때 읽은 원래 WUSBDENABLE 값
const _devicePortMap    = {};     // serial → port (IMEI 매칭 결과)

// SRSD 네트워크 연결
let selectedSrsdIp   = '';       // 연결된 단말기 IP
let selectedSrsdPort = 5002;     // SRSD 데몬 UDP 포트

let _srsdLogPollTimer = null;   // SRSD 모드 로그 폴링 타이머
const SRSD_LOG_POLL_MS = 3000;

// ── 범용 명령 헬퍼 (USB ↔ SRSD 자동 라우팅) ──────────────────────────
// SRSD 연결 중이면 UDP 경로, 아니면 기존 ADB/시리얼 경로 사용

async function _atCmd(command, timeout = 10, tag = 'cmd') {
  if (selectedSrsdIp)
    return sendCommand({ type: 'srsd_at', ip: selectedSrsdIp,
                         port: selectedSrsdPort, command, timeout }, tag);
  if (!selectedPort)
    return { success: false, error: '시리얼 포트를 먼저 연결하거나 SRSD를 연결하세요.' };
  return sendCommand({ type: 'at_command', port: selectedPort, command, timeout }, tag);
}

async function _shellCmd(command, timeout = 30, tag = 'cmd') {
  if (selectedSrsdIp)
    return sendCommand({ type: 'srsd_shell', ip: selectedSrsdIp,
                         port: selectedSrsdPort, command, timeout }, tag);
  if (!selectedSerial)
    return { success: false, error: '디바이스를 먼저 선택하거나 SRSD를 연결하세요.' };
  return sendCommand({ type: 'adb_shell', serial: selectedSerial, command }, tag);
}

// 연결 상태 체크 — SRSD 또는 USB 준비 여부 확인
function _connReady({ needAt = false, needShell = false } = {}) {
  if (selectedSrsdIp) return true;
  if (needAt && !selectedPort) {
    toast('시리얼 포트를 먼저 연결하거나 SRSD를 연결하세요.', true); return false;
  }
  if (needShell && !selectedSerial) {
    toast('디바이스를 먼저 선택하거나 SRSD를 연결하세요.', true); return false;
  }
  return true;
}
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
    socket = io({ transports: ['websocket'], reconnection: true,
                  path: '/remotediag/socket.io' });

    socket.on('connect', () => {
      socket.emit('browser_hello');
    });

    socket.on('agent_status', (d) => {
      const wasConnected = agentConnected;
      agentConnected = d.connected;
      if (d.username && !currentUser) {
        currentUser  = d.username;
        currentPerms = d.permissions || [];
        applyPermissions();
        hideLogin();
      }
      updateAgentUI(d);
      if (d.connected && !wasConnected) {
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

  fetch('api/me')
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

  fetch('api/server-info').then(r => r.json()).then(info => {
    const exeBtn       = document.getElementById('btn-download-exe');
    const bannerExeBtn = document.getElementById('banner-btn-exe');
    if (!info.exe_ready) {
      [exeBtn, bannerExeBtn].forEach(b => {
        if (!b) return;
        b.textContent  = '⬇ woorinet_remote_diag_agent.exe (미빌드)';
        b.title        = 'build_agent.bat 실행 후 dist/woorinet_remote_diag_agent.exe를 서버에 복사하세요.';
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

  const res = await fetch('api/login', {
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

  await fetch('api/logout', { method: 'POST' });
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
    result = await _atCmd(cmd, data.timeout || 10, 'rc');
  } else if (type === 'adb_shell') {
    result = await _shellCmd(cmd, 30, 'rc');
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
    // 선택된 에이전트 SID 자동 포함 (서버가 라우팅에 사용)
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
  if (!_connReady({ needShell: true })) return;
  pushHistory(adbHistory, cmd); adbHistIdx = -1; input.value = '';

  appendLine('term-adb', `$ ${cmd}`, 't-cmd');
  const res = await _shellCmd(cmd, 30, 'adb');
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
  if (!_connReady({ needShell: true })) return;
  _setPreContent(`pre-${secId}`, '<span class="dim-text">읽는 중...</span>');
  const res = await _shellCmd(cmd, 30, 'sec');
  if (res.success && res.stdout) {
    _setPreText(`pre-${secId}`, res.stdout);
  } else {
    const msg = res.stderr || res.error || '오류가 발생했습니다.';
    _setPreContent(`pre-${secId}`, `<span class="t-err">${escapeHtml(msg)}</span>`);
  }
}

async function _fetchSectionAt() {
  if (!_connReady({ needAt: true })) return;
  _setPreContent('pre-sec-at', '<span class="dim-text">읽는 중...</span>');
  const lines = [];
  const r1 = await _atCmd('AT$$DBS', 10, 'sec');
  lines.push('▶ AT$$DBS');
  lines.push(r1.response || r1.error || '(응답 없음)');
  lines.push('');
  const r2 = await _atCmd('AT+CGDCONT?', 10, 'sec');
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
  if (!_connReady({ needShell: true })) return;
  _setPreContent('pre-sec-dns', '<span class="dim-text">읽는 중...</span>');
  const r = await _shellCmd('cat /var/run/data/dnsmasq.conf.bridge0', 30, 'sec');
  if (!r.success) {
    _setPreContent('pre-sec-dns', `<span class="t-err">${escapeHtml(r.error || '오류')}</span>`);
    return;
  }
  const text = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '');
  _setPreContent('pre-sec-dns', _renderDnsmasqConf(text));
}

// 전체 새로고침: 열려 있는 섹션만 다시 로드
async function loadAllDeviceInfo() {
  if (!_connReady({ needShell: true })) return;
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
function _stopSrsdLogPoll() {
  if (_srsdLogPollTimer) { clearInterval(_srsdLogPollTimer); _srsdLogPollTimer = null; }
}

function _setLogRunningUI(running, label = '') {
  const startBtn  = document.getElementById('log-start-btn');
  const stopBtn   = document.getElementById('log-stop-btn');
  const statusEl  = document.getElementById('log-status');
  if (startBtn) startBtn.disabled = running;
  if (stopBtn)  stopBtn.disabled  = !running;
  if (statusEl) {
    statusEl.textContent = running ? `▶ ${label}` : '■ 정지';
    statusEl.style.color = running ? 'var(--green)' : 'var(--text-dim)';
  }
}

async function startLog() {
  if (!_connReady({ needShell: true })) return;
  if (logRunning) await stopLog();
  const path = document.getElementById('log-source').value;

  if (selectedSrsdIp) {
    // SRSD 모드: 폴링 방식 (tail -n 100 을 3초마다 실행)
    logRunning = true;
    _setLogRunningUI(true, `${path} [SRSD]`);
    const poll = async () => {
      if (!logRunning) return;
      const r = await _shellCmd(`tail -n 100 ${path}`, 10, 'log_poll');
      if (r.success && r.stdout) {
        const term = document.getElementById('term-logs');
        if (term) { term.textContent = r.stdout.replace(/\r/g, '').trimEnd(); autoScroll(term); }
      }
    };
    await poll();
    _srsdLogPollTimer = setInterval(poll, SRSD_LOG_POLL_MS);
  } else {
    // USB 모드: 기존 스트리밍
    const res = await sendCommand({ type: 'log_start', serial: selectedSerial, path });
    if (res.success) {
      logRunning = true;
      _setLogRunningUI(true, path);
    } else {
      toast(res.error || '로그 시작 실패', true);
    }
  }
}

async function stopLog() {
  _stopSrsdLogPoll();
  if (!selectedSrsdIp) await sendCommand({ type: 'log_stop' });
  logRunning = false;
  _setLogRunningUI(false);
}

async function downloadLog(path, filename) {
  if (!_connReady({ needShell: true })) return;
  toast(`${filename} 읽는 중...`);
  const res = await _shellCmd(`cat ${path}`, 60, 'log_get');
  if (!res.success) { toast(res.error || '파일 읽기 실패', true); return; }
  _downloadText(res.stdout || '', filename + '.log');
}

async function uploadLogs() {
  if (!_connReady({ needShell: true })) return;
  const btn    = document.getElementById('log-upload-btn');
  const status = document.getElementById('log-upload-status');
  btn.disabled    = true;
  btn.textContent = '수집 중...';
  status.textContent = '로그 수집 중 (dmesg, /data/logs/*, /var/log/messages) ...';

  const cmd = selectedSrsdIp
    ? { type: 'srsd_log_upload', ip: selectedSrsdIp, port: selectedSrsdPort }
    : { type: 'log_upload', serial: selectedSerial, port: selectedPort };
  const res = await sendCommand(cmd, 'log_upload');
  if (!res.success) {
    toast(res.error || '업로드 요청 실패', true);
    btn.disabled    = false;
    btn.textContent = '⬆ 로그 업로드';
    status.textContent = '';
    return;
  }
  status.textContent = '서버로 전송 중...';
}

function onLogUploadResult(d) {
  // 로그 업로드 결과
  const logBtn    = document.getElementById('log-upload-btn');
  const logStatus = document.getElementById('log-upload-status');
  // kmsg 업로드 결과
  const kmsgBtn    = document.getElementById('kmsg-upload-btn');
  const kmsgStatus = document.getElementById('kmsg-upload-status');

  // kmsg 업로드 중이면 kmsg UI 복원, 아니면 log UI 복원
  const isKmsg = kmsgBtn && kmsgBtn.disabled;

  if (isKmsg) {
    kmsgBtn.disabled    = false;
    kmsgBtn.textContent = '⬆ kmsg 업로드';
    if (d.success) {
      const warn = d.errors && d.errors.length ? `  (실패 ${d.errors.length}개)` : '';
      toast(`kmsg 업로드 완료: ${d.count}개 파일 저장${warn}`);
      kmsgStatus.textContent = `✓ 저장 위치: ${d.path}  (${d.count}개 파일)${warn}`;
    } else {
      toast('업로드 실패: ' + (d.error || '알 수 없는 오류'), true);
      kmsgStatus.textContent = '';
    }
  } else {
    if (logBtn) { logBtn.disabled = false; logBtn.textContent = '⬆ 로그 업로드'; }
    if (d.success) {
      const warn = d.errors && d.errors.length ? `  (실패 ${d.errors.length}개)` : '';
      toast(`로그 업로드 완료: ${d.count}개 파일 저장${warn}`);
      if (logStatus) logStatus.textContent = `✓ 저장 위치: ${d.path}  (${d.count}개 파일)${warn}`;
    } else {
      toast('업로드 실패: ' + (d.error || '알 수 없는 오류'), true);
      if (logStatus) logStatus.textContent = '';
    }
  }
}

async function uploadKmsg() {
  if (!_connReady({ needShell: true })) return;
  const btn    = document.getElementById('kmsg-upload-btn');
  const status = document.getElementById('kmsg-upload-status');
  btn.disabled    = true;
  btn.textContent = '수집 중...';
  status.textContent = 'kmsg(dmesg) 수집 중...';

  const cmd = selectedSrsdIp
    ? { type: 'srsd_kmsg_upload', ip: selectedSrsdIp, port: selectedSrsdPort }
    : { type: 'kmsg_upload', serial: selectedSerial };
  const res = await sendCommand(cmd, 'kmsg_upload');
  if (!res.success) {
    toast(res.error || '업로드 요청 실패', true);
    btn.disabled    = false;
    btn.textContent = '⬆ kmsg 업로드';
    status.textContent = '';
    return;
  }
  status.textContent = '서버로 전송 중...';
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
  if (!kmsgRunning) return;
  if (!selectedSrsdIp && !selectedSerial) return;
  let data;
  if (selectedSrsdIp) {
    const res = await _shellCmd('dmesg', 30, 'kmsg_poll');
    if (!res.success) return;
    data = res.stdout;
  } else {
    const res = await sendCommand({ type: 'kmsg_get', serial: selectedSerial }, 'kmsg_poll');
    if (!res.success) return;
    data = res.data;
  }
  if (data) {
    const term = document.getElementById('term-kmsg');
    if (term) { term.textContent = data.replace(/\r/g, '').trimEnd(); autoScroll(term); }
    const ts = new Date().toLocaleTimeString();
    document.getElementById('kmsg-status').textContent = `▶ 실행 중  (갱신: ${ts})`;
  }
}

function startKmsg() {
  if (!_connReady({ needShell: true })) return;
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
  if (!_connReady({ needShell: true })) return;
  toast('kmsg 읽는 중...');
  let data;
  if (selectedSrsdIp) {
    const res = await _shellCmd('dmesg', 30, 'kmsg_get');
    if (!res.success) { toast(res.error || 'kmsg 읽기 실패', true); return; }
    data = res.stdout;
  } else {
    const res = await sendCommand({ type: 'kmsg_get', serial: selectedSerial }, 'kmsg_get');
    if (!res.success) { toast(res.error || 'kmsg 읽기 실패', true); return; }
    data = res.data;
  }
  _downloadText(data || '', 'kmsg.log');
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

  // 이미 다른 포트가 열려 있으면 먼저 닫기
  if (selectedPort && selectedPort !== port) {
    toast(`${selectedPort} 닫는 중...`);
    await sendCommand({ type: 'at_command', port: selectedPort, command: 'AT!UNLOCK=2,"W353"', timeout: 5 });
    await sendCommand({ type: 'at_command', port: selectedPort, command: 'AT*WUSBDENABLE=3', timeout: 5 });
    const closeRes = await sendCommand({ type: 'at_close', port: selectedPort });
    if (closeRes.success) {
      Object.keys(_devicePortMap).forEach(s => { if (_devicePortMap[s] === selectedPort) delete _devicePortMap[s]; });
      selectedPort = '';
      selectedSerial = '';
      document.getElementById('at-port-display').textContent = '미연결';
      document.getElementById('device-list').innerHTML =
        '<span class="dim-text">시리얼 포트를 먼저 연결하세요</span>';
    }
  }

  const res = await sendCommand({ type: 'at_open', port, baudrate: parseInt(baudrate) });
  if (!res.success) { toast(res.message || res.error || '오류', true); return; }

  selectedPort = port;
  document.getElementById('at-port-display').textContent = port;
  _setSidebarMode('usb');
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
    _setSidebarMode('none');
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
  if (!_connReady({ needAt: true })) return;
  if (!cmd.toUpperCase().startsWith('AT')) cmd = 'AT' + cmd;
  pushHistory(atHistory, cmd); atHistIdx = -1; input.value = '';

  const timeout = parseFloat(document.getElementById('at-timeout').value) || 5;
  appendLine('term-at', `▶ ${cmd}`, 't-cmd');
  const res = await _atCmd(cmd, timeout, 'at');
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
  { id: 'rmnet4',  label: 'RMNET IPv4 IP 확인' },
  { id: 'rmnet6',  label: 'RMNET IPv6 IP 확인' },
  { id: 'bridge0', label: 'BRIDGE0 인터페이스 확인' },
  { id: 'ping4',   label: 'IPv4 Ping (8.8.8.8)' },
  { id: 'ping6',   label: 'IPv6 Ping (2001:4860:4860::8888)' },
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
    fail:    { icon: '✗', color: 'var(--red)'   },
    skip:    { icon: '—', color: 'var(--text-dim)' },
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
  const useSrsd = !!selectedSrsdIp;

  if (useSrsd) {
    // SRSD 모드: 네트워크로 직접 접속, ADB/시리얼 포트 불필요
  } else {
    if (!selectedSerial) { toast('디바이스를 먼저 선택하거나 SRSD 연결을 설정하세요.', true); return; }
    if (!selectedPort)   { toast('시리얼 포트를 먼저 연결하세요.', true); return; }
  }

  const btn = document.getElementById('diag-run-btn');
  btn.disabled = true;
  const modeLabel = useSrsd ? `SRSD(${selectedSrsdIp})` : 'USB';
  document.getElementById('diag-overall').textContent = `점검 중... [${modeLabel}]`;
  document.getElementById('diag-overall').style.color = 'var(--text-dim)';
  _diagBuildTable();

  // ── 모드에 따라 명령 라우팅 ──────────────────────────────────────
  const atCmd = (cmd, timeout = 10) => {
    if (useSrsd)
      return sendCommand({ type: 'srsd_at', ip: selectedSrsdIp,
                           port: selectedSrsdPort, command: cmd, timeout }, 'diag');
    return sendCommand({ type: 'at_command', port: selectedPort, command: cmd, timeout }, 'diag');
  };
  const shellCmd = (cmd, timeout = 30) => {
    if (useSrsd)
      return sendCommand({ type: 'srsd_shell', ip: selectedSrsdIp,
                           port: selectedSrsdPort, command: cmd, timeout }, 'diag');
    return sendCommand({ type: 'adb_shell', serial: selectedSerial, command: cmd }, 'diag');
  };

  const failedSteps = [];
  const fail = (id, msg) => {
    failedSteps.push(msg);
    _diagSetRow(id, 'fail', msg);
  };

  // ── 1. IMEI ────────────────────────────────────────────────────────
  _diagSetRow('imei', 'running', '확인 중...');
  const imeiRes = await shellCmd('cat /var/tmp/imei');
  const imei = (imeiRes.stdout || '').trim();
  if (!imeiRes.success || !imei || /^0+$/.test(imei) || imei.length < 10) {
    fail('imei', 'IMEI 정보 오류');
  } else {
    _diagSetRow('imei', 'ok', imei);
  }

  // ── 2. PHONE 번호 ──────────────────────────────────────────────────
  _diagSetRow('phone', 'running', '확인 중...');
  const phoneRes = await shellCmd('cat /var/tmp/phone_number');
  const phone = (phoneRes.stdout || '').trim().replace(/\D/g, '');
  if (!phoneRes.success || !/^0(10|12)\d{7,8}$/.test(phone)) {
    fail('phone', '번호 정보 오류');
  } else {
    _diagSetRow('phone', 'ok', phone);
  }

  // ── 3. USIM 상태 ──────────────────────────────────────────────────
  _diagSetRow('usim', 'running', '확인 중...');
  const usimRes  = await atCmd('AT*WSTAT?', 5);
  const usimResp = (usimRes.response || '').toUpperCase();
  const wstatM   = (usimRes.response || '').match(/\*WSTAT\s*:\s*([^\r\n]+)/i);
  const usimVal  = wstatM ? wstatM[1].trim() : (usimRes.response || '').trim();
  if (usimResp.includes('READY')) {
    _diagSetRow('usim', 'ok', usimVal);
  } else if (usimResp.includes('TESTCARD')) {
    _diagSetRow('usim', 'ok', usimVal);
  } else if (usimResp.includes('OPEN')) {
    fail('usim', `미개통 (${usimVal})`);
  } else {
    fail('usim', `USIM 오류 (${usimVal})`);
  }

  // ── 4. RMNET IP (V4 / V6 개별 확인) ──────────────────────────────
  _diagSetRow('rmnet4', 'running', '확인 중...');
  _diagSetRow('rmnet6', 'running', '확인 중...');
  const ipRes  = await atCmd('AT*WWANIP?', 5);
  const ipResp = ipRes.response || '';

  // 줄 단위로 분리 후 V4: / V6: 라인만 찾아서 값 추출
  const ipLines = ipResp.split(/\r?\n|\r/);
  const v4line  = ipLines.find(l => /^V4:/i.test(l.trim()));
  const v6line  = ipLines.find(l => /^V6:/i.test(l.trim()));
  const v4ip    = v4line ? v4line.replace(/^V4:\s*/i, '').trim() : '';
  const v6ip    = v6line ? v6line.replace(/^V6:\s*/i, '').trim() : '';

  // 유효한 IPv4: x.x.x.x 형식 + 0.0.0.0 제외
  const isValidV4 = ip =>
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) && ip !== '0.0.0.0';

  // 유효한 IPv6: 16진수+콜론 형식 + :: / 전체 0 제외
  const isValidV6 = ip =>
    /^[0-9a-f:]+$/i.test(ip) && ip.includes(':') &&
    ip !== '::' && ip !== '::0' && ip !== '0:0:0:0:0:0:0:0';

  const hasV4 = isValidV4(v4ip);
  const hasV6 = isValidV6(v6ip);

  if (hasV4) {
    _diagSetRow('rmnet4', 'ok', v4ip);
  } else {
    fail('rmnet4', v4ip ? `IPv4 유효하지 않음 (${v4ip})` : 'IPv4 미할당');
  }
  if (hasV6) {
    _diagSetRow('rmnet6', 'ok', v6ip);
  } else {
    _diagSetRow('rmnet6', 'skip', v6ip ? `IPv6 유효하지 않음 (${v6ip})` : 'IPv6 미할당');
  }

  // ── 5. BRIDGE0 인터페이스 ─────────────────────────────────────────
  _diagSetRow('bridge0', 'running', '확인 중...');
  const ifRes = await shellCmd('ifconfig');
  if (!ifRes.success || !(ifRes.stdout || '').includes('bridge0')) {
    fail('bridge0', '네트워크 인터페이스 오류');
  } else {
    _diagSetRow('bridge0', 'ok', '확인됨');
  }

  // ── 6. IPv4 Ping (IPv4 미할당 시 SKIP) ──────────────────────────
  if (!hasV4) {
    _diagSetRow('ping4', 'skip', 'IPv4 미할당 — 건너뜀');
  } else {
    _diagSetRow('ping4', 'running', '확인 중...');
    const ping4Res = await shellCmd('ping -c 3 -W 3 8.8.8.8 2>&1');
    const ping4Out = (ping4Res.stdout || '') + (ping4Res.stderr || '');
    const ping4Ok  = /bytes from/i.test(ping4Out) ||
      (/(\d+)\s+received/i.test(ping4Out) &&
       parseInt((ping4Out.match(/(\d+)\s+received/i) || [])[1] || '0') > 0);
    if (ping4Ok) {
      const m4 = ping4Out.match(/\/(\d+(?:\.\d+)?)\/[\d.]+\s*ms/);
      _diagSetRow('ping4', 'ok', m4 ? `avg ${m4[1]} ms` : '응답 있음');
    } else {
      fail('ping4', 'IPv4 Ping 실패');
    }
  }

  // ── 7. IPv6 Ping (IPv6 미할당 시 SKIP) ───────────────────────────
  if (!hasV6) {
    _diagSetRow('ping6', 'skip', 'IPv6 미할당 — 건너뜀');
  } else {
    _diagSetRow('ping6', 'running', '확인 중...');
    const ping6Res = await shellCmd('ping6 -c 3 -W 3 2001:4860:4860::8888 2>&1');
    const ping6Out = (ping6Res.stdout || '') + (ping6Res.stderr || '');
    const ping6Ok  = /bytes from/i.test(ping6Out) ||
      (/(\d+)\s+received/i.test(ping6Out) &&
       parseInt((ping6Out.match(/(\d+)\s+received/i) || [])[1] || '0') > 0);
    if (ping6Ok) {
      const m6 = ping6Out.match(/\/(\d+(?:\.\d+)?)\/[\d.]+\s*ms/);
      _diagSetRow('ping6', 'ok', m6 ? `avg ${m6[1]} ms` : '응답 있음');
    } else {
      fail('ping6', 'IPv6 Ping 실패');
    }
  }

  // ── 전체 결과 ─────────────────────────────────────────────────────
  if (failedSteps.length > 0) {
    _diagVerdict(false, `✗ 이상 감지: ${failedSteps.join(', ')}`);
  } else {
    _diagVerdict(true, '✓ 모든 항목 정상');
  }
  btn.disabled = false;
}

// ── SRSD 네트워크 연결 ────────────────────────────────────────────────

function _srsdStatusEl() { return document.getElementById('srsd-status'); }

function _srsdSetStatus(msg, color) {
  const el = _srsdStatusEl();
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || 'var(--text-dim)';
}

// 사이드바 상호 비활성화
// mode: 'usb' → 네트워크 섹션 잠금 / 'network' → USB 섹션 잠금 / 'none' → 모두 해제
function _setSidebarMode(mode) {
  ['aside-serial', 'aside-adb'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('section-disabled', mode === 'network');
  });
  const net = document.getElementById('aside-network');
  if (net) net.classList.toggle('section-disabled', mode === 'usb');
}

async function srsdDiscover() {
  if (!agentConnected) { toast('에이전트가 연결되지 않았습니다.', true); return; }
  const port = parseInt(document.getElementById('srsd-port').value) || 5002;
  _srsdSetStatus('🔍 탐색 중...', 'var(--blue)');
  const res = await sendCommand({ type: 'srsd_discover', port }, 'srsd_disc');
  if (!res.success) {
    _srsdSetStatus('탐색 실패: ' + (res.error || ''), 'var(--red)');
    return;
  }
  const ips = res.data || [];
  if (ips.length === 0) {
    _srsdSetStatus('단말기를 찾지 못했습니다.', 'var(--text-dim)');
    return;
  }
  document.getElementById('srsd-ip').value = ips[0];
  _srsdSetStatus(`발견: ${ips.join(', ')}`, 'var(--green)');
  toast(`단말기 발견: ${ips[0]}`);
}

async function srsdConnect() {
  if (!agentConnected) { toast('에이전트가 연결되지 않았습니다.', true); return; }
  const ip   = document.getElementById('srsd-ip').value.trim();
  const port = parseInt(document.getElementById('srsd-port').value) || 5002;
  if (!ip) { toast('단말기 IP를 입력하세요.', true); return; }

  _srsdSetStatus('연결 확인 중...', 'var(--blue)');
  const res = await sendCommand(
    { type: 'srsd_at', ip, port, command: 'AT', timeout: 5 }, 'srsd_test');

  if (res.success) {
    selectedSrsdIp   = ip;
    selectedSrsdPort = port;
    _srsdSetStatus(`✓ ${ip}:${port} 연결됨`, 'var(--green)');
    toast(`네트워크 연결 성공: ${ip}`);
    _setSidebarMode('network');
  } else {
    selectedSrsdIp = '';
    const err = res.error || res.response || '응답 없음';
    _srsdSetStatus(`✗ 연결 실패: ${err}`, 'var(--red)');
    toast('연결 실패: ' + err, true);
  }
}

function srsdDisconnect() {
  _stopSrsdLogPoll();
  selectedSrsdIp = '';
  document.getElementById('srsd-ip').value = '';
  _srsdSetStatus('해제됨', 'var(--text-dim)');
  toast('네트워크 연결 해제');
  _setSidebarMode('none');
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
