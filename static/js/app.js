'use strict';

// ── State ─────────────────────────────────────────────────────────────
let selectedSerial      = '';
let selectedPort        = '';
let selectedModel       = '';
let selectedCustomer    = '';
let agentConnected      = false;
let _wusbdEnableOrig    = null;   // 포트 열 때 읽은 원래 WUSBDENABLE 값
const _devicePortMap    = {};     // serial → port (IMEI 매칭 결과)

// SRSD 네트워크 연결
let selectedSrsdIp   = '';       // 연결된 단말기 IP
let selectedSrsdPort = 5002;     // SRSD 데몬 UDP 포트

let _srsdLogPollTimer = null;   // SRSD 모드 로그 폴링 타이머
const SRSD_LOG_POLL_MS = 3000;

// ── engine.js(ES module)에서 let 변수에 접근할 수 있도록 window에 게터 노출 ──
Object.defineProperties(window, {
  selectedSerial:   { get: () => selectedSerial,   enumerable: true },
  selectedPort:     { get: () => selectedPort,     enumerable: true },
  selectedSrsdIp:   { get: () => selectedSrsdIp,   enumerable: true },
  selectedSrsdPort: { get: () => selectedSrsdPort, enumerable: true },
  selectedModel:    { get: () => selectedModel,    enumerable: true },
  selectedCustomer: { get: () => selectedCustomer, enumerable: true },
});

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
      if (d.connected) {
        if (d.username && !currentUser) {
          currentUser  = d.username;
          currentPerms = d.permissions || [];
          applyPermissions();
        }
        hideTokenOverlay();
        updateAgentUI(d);
        if (!wasConnected) {
          refreshDevices();
          refreshPorts();
        }
      } else if (wasConnected) {
        // 연결 중이었다가 끊긴 경우 — 팝업 후 토큰 입력 화면으로 전환
        const reason = d.reason || '에이전트 연결이 종료되었습니다.';
        updateAgentUI(d);
        currentUser  = null;
        currentPerms = [];
        setTimeout(() => {
          alert('[에이전트 종료]\n\n' + reason + '\n\n접속 코드를 다시 입력하세요.');
          showTokenOverlay();
        }, 100);
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

    socket.on('pair_result', (d) => {
      const errEl = document.getElementById('token-error');
      if (!d.success) {
        if (errEl) { errEl.textContent = d.error; errEl.style.display = 'block'; }
        return;
      }
      // 유효한 코드 확인 → step2로 전환
      const step1  = document.getElementById('token-step1');
      const step2  = document.getElementById('token-step2');
      const status = document.getElementById('token-status');
      if (step1) step1.style.display = 'none';
      if (step2) step2.style.display = 'block';
      if (d.waiting  && status) status.textContent = '⏳ 에이전트 연결 대기 중...';
      if (d.connected && status) status.textContent = '✅ 연결됨';
    });
  } catch (e) {
    console.error('Socket.IO 초기화 실패:', e);
    toast('Socket.IO 로드 실패. 페이지를 새로고침하세요.', true);
  }

  // 항상 토큰 입력 화면으로 시작
  showTokenOverlay();

  fetch('api/server-info').then(r => r.json()).then(info => {
    const exeBtn     = document.getElementById('btn-download-exe');
    const tokenDlBtn = document.getElementById('token-download-btn');
    if (!info.exe_ready) {
      [exeBtn, tokenDlBtn].forEach(b => {
        if (!b) return;
        b.textContent  = '⬇ 에이전트 (미빌드)';
        b.title        = 'build_agent.bat 실행 후 dist/woorinet_remote_diag_agent.exe를 서버에 복사하세요.';
        b.style.opacity = '0.5';
      });
    }
  }).catch(() => {});
});

// ── Token overlay ─────────────────────────────────────────────────────
function showTokenOverlay() {
  // step1(코드 입력)으로 초기화
  const step1 = document.getElementById('token-step1');
  const step2 = document.getElementById('token-step2');
  const errEl = document.getElementById('token-error');
  const status = document.getElementById('token-status');
  const input  = document.getElementById('token-code');
  if (step1) step1.style.display = 'block';
  if (step2) step2.style.display = 'none';
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  if (status) status.textContent = '';
  if (input)  input.value = '';
  document.getElementById('token-overlay').style.display = 'flex';
}
function hideTokenOverlay() {
  document.getElementById('token-overlay').style.display = 'none';
  const label = document.getElementById('user-label');
  if (label) label.textContent = currentUser ? `👤 ${currentUser}` : '';
  showDriverGuide();
}

function showDriverGuide() {
  const overlay = document.getElementById('driver-guide-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
}

function closeDriverGuide() {
  const overlay = document.getElementById('driver-guide-overlay');
  if (overlay) overlay.style.display = 'none';
}

function doTokenConnect() {
  const input  = document.getElementById('token-code');
  const code   = (input?.value || '').trim();
  const errEl  = document.getElementById('token-error');
  const status = document.getElementById('token-status');
  errEl.style.display = 'none';

  if (!code) {
    errEl.textContent   = '접속 코드를 입력하세요.';
    errEl.style.display = 'block';
    return;
  }
  status.textContent = '연결 중...';
  socket.emit('browser_pair', { code });
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
  showTokenOverlay();
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

// ADB 없이 AT만 사용 가능한 탭 목록
const AT_ONLY_TABS = new Set(['at', 'guide']);

function applyPermissions() {
  applyConnectionState();
  applyGuidePermissions();
}

function applyConnectionState() {
  const allTabs = ['adb-info', 'diag', 'at', 'adb-shell', 'logs', 'kmsg', 'guide'];
  const atOnlyMode = selectedPort && !selectedSerial;  // 포트 열림 + ADB 없음

  allTabs.forEach(tabId => {
    const el = document.querySelector(`.tab[data-tab="${tabId}"]`);
    if (!el) return;
    const permitted = hasPermission(tabId);
    const available = !atOnlyMode || AT_ONLY_TABS.has(tabId);
    el.style.display = (permitted && available) ? '' : 'none';
  });

  // 현재 탭이 숨겨졌으면 첫 번째 접근 가능한 탭으로 이동
  const visibleTabs = allTabs.filter(t => {
    const el = document.querySelector(`.tab[data-tab="${t}"]`);
    return el && el.style.display !== 'none';
  });
  const currentPanel = document.querySelector('.panel.active');
  const currentTabId = currentPanel?.id?.replace('panel-', '');
  if (!visibleTabs.includes(currentTabId) && visibleTabs.length) {
    switchTab(visibleTabs[0]);
  }
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

function doPairAgent() {
  const input = document.getElementById('pair-code');
  const code  = (input?.value || '').trim();
  if (!code) { toast('접속 코드를 입력하세요.', true); return; }
  const status = document.getElementById('pair-status');
  if (status) status.textContent = '연결 중...';
  socket.emit('browser_pair', { code });
}

// ── Tabs ──────────────────────────────────────────────────────────────
function switchTab(id) {
  const prevTab = document.querySelector('.tab.active')?.dataset.tab;

  // 이탈 처리
  if (prevTab === 'kmsg' && id !== 'kmsg') _stopKmsgPoll();
  if (prevTab === 'diag'     && id !== 'diag')     window.DiagEngine?.leave();
  if (prevTab === 'adb-info' && id !== 'adb-info') window.DevInfoEngine?.leave();

  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === id));
  document.querySelectorAll('.panel').forEach(p =>
    p.classList.toggle('active', p.id === `panel-${id}`));

  if (id === 'at') {
    document.getElementById('at-port-display').textContent = selectedPort || '미연결';
  }

  // 진입 처리
  if (id === 'kmsg')     _startKmsgPoll();
  if (id === 'diag')     window.DiagEngine?.enter(document.getElementById('diag-mount'));
  if (id === 'adb-info') window.DevInfoEngine?.enter(document.getElementById('devinfo-mount'));
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
    _readDeviceAttrs();
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
  if (status === 'device') _readDeviceAttrs();
}

async function _readDeviceAttrs() {
  try {
    const [mRes, cRes] = await Promise.all([
      _shellCmd('cat /sys/devices/soc0/wnet_model', 5, 'devattr'),
      _shellCmd('cat /sys/devices/soc0/wnet_customer', 5, 'devattr'),
    ]);
    selectedModel    = (mRes.stdout || '').trim();
    selectedCustomer = (cRes.stdout || '').trim();
  } catch (_) {
    selectedModel = selectedCustomer = '';
  }
  console.log('[DevAttr] model:', selectedModel, '| customer:', selectedCustomer);
  window.DiagEngine?.reset();
  window.DevInfoEngine?.reset();
  _remountActiveEngine();
}

function _clearDeviceAttrs() {
  selectedModel = selectedCustomer = '';
  window.DiagEngine?.reset();
  window.DevInfoEngine?.reset();
  _remountActiveEngine();
}

function _remountActiveEngine() {
  const activeTab = document.querySelector('.tab.active')?.dataset.tab;
  if (activeTab === 'diag')
    window.DiagEngine?.enter(document.getElementById('diag-mount'));
  if (activeTab === 'adb-info')
    window.DevInfoEngine?.enter(document.getElementById('devinfo-mount'));
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

async function _doKmsgGet() {
  const term = document.getElementById('term-kmsg');
  const status = document.getElementById('kmsg-status');
  if (status) status.textContent = '읽는 중...';

  let data;
  if (selectedSrsdIp) {
    const res = await _shellCmd('dmesg | tail -n 500', 30, 'kmsg_get');
    if (!res.success) { if (status) status.textContent = '실패'; return; }
    data = res.stdout;
  } else {
    const res = await sendCommand({ type: 'kmsg_get', serial: selectedSerial }, 'kmsg_get');
    if (!res.success) { if (status) status.textContent = '실패'; return; }
    data = res.data;
  }

  if (term) { term.textContent = (data || '').replace(/\r/g, '').trimEnd(); autoScroll(term); }
  const ts = new Date().toLocaleTimeString();
  if (status) status.textContent = `최근 갱신: ${ts}`;
}

function startKmsg() {
  if (!_connReady({ needShell: true })) return;
  kmsgRunning = true;
  _doKmsgGet();
}

function stopKmsg() {
  kmsgRunning = false;
  _stopKmsgPoll();
  document.getElementById('kmsg-status').textContent = '■ 정지';
}

async function refreshKmsg() {
  if (!_connReady({ needShell: true })) return;
  const btn = document.getElementById('kmsg-refresh-btn');
  if (btn) btn.disabled = true;
  await _doKmsgGet();
  if (btn) btn.disabled = false;
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
    _wusbdEnableOrig = val;
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

    const devRes = await sendCommand({ type: 'adb_devices' }, 'refresh_devices');
    matchRes = await sendCommand({ type: 'at_match_device', port }, 'at_match');
    if (matchRes.success && matchRes.serial) {
      Object.keys(_devicePortMap).forEach(s => { if (_devicePortMap[s] === port) delete _devicePortMap[s]; });
      _devicePortMap[matchRes.serial] = port;
      selectedSerial = matchRes.serial;
      if (devRes.success) applyDeviceList(devRes.data);
      toast(`${port} ↔ ${matchRes.serial} 자동 매칭 (${attempt}회 시도)`);
      applyConnectionState();  // ADB 연결 성공 → 전체 탭 표시
      _readDeviceAttrs();
      break;
    }

    if (attempt < MAX_MATCH) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  if (!matchRes || !matchRes.success) {
    // AT$OPENADB 폴백 시도
    const opened = await _tryOpenADB(port, deviceEl);
    if (!opened) {
      deviceEl.innerHTML = '<span class="dim-text">매칭 실패 — AT Command만 사용 가능합니다</span>';
      toast('ADB 연결 실패 — AT Command 탭만 사용 가능합니다', true);
      applyConnectionState();
    }
  }
}

// AT$OPENADB 폴백 시퀀스
async function _tryOpenADB(port, deviceEl) {
  deviceEl.innerHTML = '<span class="dim-text">AT$OPENADB 시도 중...</span>';

  // (0) UNLOCK
  const unlockRes = await sendCommand({ type: 'at_command', port, command: 'AT!UNLOCK=2,"W353"', timeout: 5 });
  if (!(unlockRes.response || '').includes('OK')) {
    toast('UNLOCK 실패 — ADB 열기 중단', true);
    return false;
  }

  // (1) ATI로 IMEI 추출
  const atiRes = await sendCommand({ type: 'at_command', port, command: 'ATI', timeout: 5 });
  const imeiMatch = (atiRes.response || '').match(/(\d{14,15})/);
  if (!imeiMatch) {
    toast('ATI IMEI 추출 실패 — ADB 열기 중단', true);
    return false;
  }
  const imei8 = imeiMatch[1].slice(-8);

  // (2) AT$OPENADB 시도 — 패스워드 순서대로
  const candidates = [`Wnet@${imei8}`, `W-net${imei8}`];
  let adbOpened = false;
  for (const pw of candidates) {
    deviceEl.innerHTML = `<span class="dim-text">AT$OPENADB 시도 중 (${pw})...</span>`;
    const res = await sendCommand({ type: 'at_command', port, command: `AT$OPENADB=on,${pw}`, timeout: 10 });
    if ((res.response || '').includes('$OPENADB:ON')) {
      adbOpened = true;
      toast(`AT$OPENADB 성공 (${pw}) — 재부팅 대기 중...`);
      break;
    }
  }

  if (!adbOpened) {
    toast('AT$OPENADB 실패 — 두 패스워드 모두 응답 없음', true);
    return false;
  }

  // (3) reboot 발생 — 완료까지 대기 (최대 60초, 5초 간격)
  const MAX_REBOOT_WAIT = 12;
  const baudrate = parseInt(document.getElementById('baud-select').value) || 115200;
  let portReopened = false;
  for (let i = 1; i <= MAX_REBOOT_WAIT; i++) {
    deviceEl.innerHTML = `<span class="dim-text">재부팅 대기 중... (${i * 5}s / ${MAX_REBOOT_WAIT * 5}s)</span>`;
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 포트가 아직 재오픈 안 됐으면 닫고 다시 열기
    if (!portReopened) {
      await sendCommand({ type: 'at_close', port });
      const reopenRes = await sendCommand({ type: 'at_open', port, baudrate });
      if (reopenRes.success) portReopened = true;
    }

    const devRes = await sendCommand({ type: 'adb_devices' }, 'refresh_devices');
    const matchRes = await sendCommand({ type: 'at_match_device', port }, 'at_match');
    if (matchRes.success && matchRes.serial) {
      Object.keys(_devicePortMap).forEach(s => { if (_devicePortMap[s] === port) delete _devicePortMap[s]; });
      _devicePortMap[matchRes.serial] = port;
      selectedSerial = matchRes.serial;
      if (devRes.success) applyDeviceList(devRes.data);
      toast(`${port} ↔ ${matchRes.serial} 자동 매칭 (AT$OPENADB)`);
      applyConnectionState();
      _readDeviceAttrs();
      return true;
    }
  }

  return false;
}

async function closePort() {
  const port = selectedPort || document.getElementById('port-select').value;
  if (!port) { toast('닫을 포트가 없습니다.', true); return; }

  // 닫기 전 AT 시퀀스
  const restoreVal = (_wusbdEnableOrig !== null) ? _wusbdEnableOrig : 3;
  await sendCommand({ type: 'at_command', port, command: 'AT!UNLOCK=2,"W353"', timeout: 5 });
  await sendCommand({ type: 'at_command', port, command: `AT*WUSBDENABLE=${restoreVal}`, timeout: 5 });

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
    applyConnectionState();  // 포트 닫힘 → 탭 상태 초기화
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

// ── 자동 점검 — engine.js + components/ 로 이관 ──────────────────────


// ── SRSD 네트워크 연결 ────────────────────────────────────────────────

function _srsdStatusEl() { return document.getElementById('srsd-status'); }

function _srsdSetStatus(msg, color) {
  const el = _srsdStatusEl();
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || 'var(--text-dim)';
}

// 사이드바 연결 탭 전환: 'usb' | 'net'
function switchConnTab(tab) {
  document.getElementById('conn-panel-usb').style.display = tab === 'usb' ? '' : 'none';
  document.getElementById('conn-panel-net').style.display = tab === 'net' ? '' : 'none';
  document.getElementById('conn-tab-usb').classList.toggle('active', tab === 'usb');
  document.getElementById('conn-tab-net').classList.toggle('active', tab === 'net');
}

// 사이드바 모드 연동
// mode: 'usb' → USB 탭 활성·네트워크 탭 비활성
//       'network' → 네트워크 탭 활성·USB 탭 비활성
//       'none' → 양쪽 모두 활성화
function _setSidebarMode(mode) {
  const usbBtn = document.getElementById('conn-tab-usb');
  const netBtn = document.getElementById('conn-tab-net');
  if (mode === 'usb') {
    switchConnTab('usb');
    usbBtn.disabled = false;
    netBtn.disabled = true;
  } else if (mode === 'network') {
    switchConnTab('net');
    usbBtn.disabled = true;
    netBtn.disabled = false;
  } else {
    usbBtn.disabled = false;
    netBtn.disabled = false;
  }
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
    _readDeviceAttrs();
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
  _clearDeviceAttrs();
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
