/**
 * WR-H902 (5G 2PORT) 자동점검 컴포넌트
 *
 * 기본 8단계 + ETH WAN 3단계 (총 11단계)
 *   9.  ETH WAN 모드 여부  (AT*WETHWANENABLE?)
 *   10. ETH WAN IP 확인   (eth0.1 인터페이스 공인 IP)
 *   11. ETH WAN Ping      (WAN IP 기반 ping)
 */

const STEPS = [
  { id: 'imei',      label: 'IMEI 확인' },
  { id: 'phone',     label: 'PHONE 번호 확인' },
  { id: 'usim',      label: 'USIM 인식' },
  { id: 'rmnet4',    label: 'RMNET IPv4 IP 확인' },
  { id: 'rmnet6',    label: 'RMNET IPv6 IP 확인' },
  { id: 'bridge0',   label: 'BRIDGE0 인터페이스 확인' },
  { id: 'ping4',     label: 'IPv4 Ping (8.8.8.8)' },
  { id: 'ping6',     label: 'IPv6 Ping (2001:4860:4860::8888)' },
  { id: 'eth_wan',   label: 'ETH WAN 모드 확인' },
  { id: 'eth_ip',    label: 'ETH WAN IP 확인 (eth0.1)' },
  { id: 'eth_ping',  label: 'ETH WAN Ping' },
];

// ── 공인 IP 판별 ─────────────────────────────────────────────────────
function _isPublicV4(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 127) return false;
  if (ip === '0.0.0.0') return false;
  return true;
}

function _isPublicV6(ip) {
  if (!ip || !ip.includes(':')) return false;
  if (ip.startsWith('fe80') || ip.startsWith('fc') || ip.startsWith('fd')) return false;
  if (ip === '::' || ip === '::1') return false;
  return true;
}

export default {
  _ctx: null,

  mount(container, ctx) {
    this._ctx = ctx;
    container.innerHTML = `
      <div class="logcat-controls">
        <button class="btn-sm success" id="diag-run-btn">▶ 점검 시작</button>
        <span id="diag-overall" class="dim-text" style="font-size:12px"></span>
      </div>
      <div style="flex:1;overflow-y:auto;padding:12px 16px">
        <table id="diag-table" style="width:100%;border-collapse:collapse;font-size:13px">
          <tbody id="diag-rows"></tbody>
        </table>
        <div id="diag-verdict"
             style="margin-top:16px;padding:10px 14px;border-radius:6px;font-size:14px;font-weight:bold;display:none">
        </div>
      </div>`;

    document.getElementById('diag-run-btn').addEventListener('click', () => this._run());
    this._buildTable();
  },

  unmount() { this._ctx = null; },

  // ── UI 헬퍼 ──────────────────────────────────────────────────────────

  _buildTable() {
    const tbody = document.getElementById('diag-rows');
    if (!tbody) return;
    tbody.innerHTML = '';
    STEPS.forEach(step => {
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
    if (v) { v.style.display = 'none'; v.textContent = ''; }
    const o = document.getElementById('diag-overall');
    if (o) o.textContent = '';
  },

  _setRow(id, state, text) {
    const row = document.getElementById('diag-row-' + id);
    if (!row) return;
    const dot = row.querySelector('.diag-dot');
    const msg = row.querySelector('.diag-msg');
    const MAP = {
      pending: { icon: '○', color: 'var(--text-dim)' },
      running: { icon: '⟳', color: 'var(--blue)'     },
      ok:      { icon: '✓', color: 'var(--green)'     },
      fail:    { icon: '✗', color: 'var(--red)'       },
      skip:    { icon: '—', color: 'var(--text-dim)'  },
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
  },

  _verdict(ok, msg) {
    const v = document.getElementById('diag-verdict');
    if (!v) return;
    v.style.display    = 'block';
    v.style.background = ok ? 'rgba(80,200,120,0.12)' : 'rgba(220,80,80,0.12)';
    v.style.color      = ok ? 'var(--green)' : 'var(--red)';
    v.style.border     = '1px solid ' + (ok ? 'var(--green)' : 'var(--red)');
    v.textContent      = msg;
    const o = document.getElementById('diag-overall');
    if (o) {
      o.textContent = ok ? '✓ 정상' : '✗ 이상 감지';
      o.style.color = ok ? 'var(--green)' : 'var(--red)';
    }
  },

  // ── 점검 실행 ─────────────────────────────────────────────────────────

  async _run() {
    const ctx     = this._ctx;
    const useSrsd = !!ctx.deviceInfo.srsdIp;

    if (!useSrsd) {
      if (!ctx.deviceInfo.serial) {
        ctx.toast('디바이스를 먼저 선택하거나 SRSD 연결을 설정하세요.', true); return;
      }
      if (!ctx.deviceInfo.port) {
        ctx.toast('시리얼 포트를 먼저 연결하세요.', true); return;
      }
    }

    const btn = document.getElementById('diag-run-btn');
    btn.disabled = true;
    const overall = document.getElementById('diag-overall');
    overall.textContent = `점검 중... [${useSrsd ? `SRSD(${ctx.deviceInfo.srsdIp})` : 'USB'}]`;
    overall.style.color = 'var(--text-dim)';
    this._buildTable();

    const atCmd    = (cmd, t = 10)  => ctx.atCmd(cmd, t);
    const shellCmd = (cmd, t = 30)  => ctx.shellCmd(cmd, t);

    const failedSteps = [];
    const fail = (id, msg) => { failedSteps.push(msg); this._setRow(id, 'fail', msg); };

    // ── 1. IMEI ──────────────────────────────────────────────────────
    this._setRow('imei', 'running', '확인 중...');
    const imeiRes = await shellCmd('cat /var/tmp/imei');
    const imei    = (imeiRes.stdout || '').trim();
    if (!imeiRes.success || !imei || /^0+$/.test(imei) || imei.length < 10) {
      fail('imei', 'IMEI 정보 오류');
    } else {
      this._setRow('imei', 'ok', imei);
    }

    // ── 2. PHONE 번호 ────────────────────────────────────────────────
    this._setRow('phone', 'running', '확인 중...');
    const phoneRes = await shellCmd('cat /var/tmp/phone_number');
    const phone    = (phoneRes.stdout || '').trim().replace(/\D/g, '');
    if (!phoneRes.success || !/^0(10|12)\d{7,8}$/.test(phone)) {
      fail('phone', '번호 정보 오류');
    } else {
      this._setRow('phone', 'ok', phone);
    }

    // ── 3. USIM 상태 ─────────────────────────────────────────────────
    this._setRow('usim', 'running', '확인 중...');
    const usimRes  = await atCmd('AT*WSTAT?', 5);
    const usimResp = (usimRes.response || '').toUpperCase();
    const wstatM   = (usimRes.response || '').match(/\*WSTAT\s*:\s*([^\r\n]+)/i);
    const usimVal  = wstatM ? wstatM[1].trim() : (usimRes.response || '').trim();
    if (usimResp.includes('READY') || usimResp.includes('TESTCARD')) {
      this._setRow('usim', 'ok', usimVal);
    } else if (usimResp.includes('OPEN')) {
      fail('usim', `미개통 (${usimVal})`);
    } else {
      fail('usim', `USIM 오류 (${usimVal})`);
    }

    // ── 4. RMNET IP ──────────────────────────────────────────────────
    this._setRow('rmnet4', 'running', '확인 중...');
    this._setRow('rmnet6', 'running', '확인 중...');
    const ipRes   = await atCmd('AT*WWANIP?', 5);
    const ipLines = (ipRes.response || '').split(/\r?\n|\r/);
    const v4line  = ipLines.find(l => /^V4:/i.test(l.trim()));
    const v6line  = ipLines.find(l => /^V6:/i.test(l.trim()));
    const v4ip    = v4line ? v4line.replace(/^V4:\s*/i, '').trim() : '';
    const v6ip    = v6line ? v6line.replace(/^V6:\s*/i, '').trim() : '';

    const isValidV4 = ip => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) && ip !== '0.0.0.0';
    const isValidV6 = ip =>
      /^[0-9a-f:]+$/i.test(ip) && ip.includes(':') &&
      ip !== '::' && ip !== '::0' && ip !== '0:0:0:0:0:0:0:0';

    const hasV4 = isValidV4(v4ip);
    const hasV6 = isValidV6(v6ip);

    if (hasV4) { this._setRow('rmnet4', 'ok',   v4ip); }
    else        { fail('rmnet4', v4ip ? `IPv4 유효하지 않음 (${v4ip})` : 'IPv4 미할당'); }
    if (hasV6)  { this._setRow('rmnet6', 'ok',   v6ip); }
    else        { this._setRow('rmnet6', 'skip', v6ip ? `IPv6 유효하지 않음 (${v6ip})` : 'IPv6 미할당'); }

    // ── 5. BRIDGE0 ───────────────────────────────────────────────────
    this._setRow('bridge0', 'running', '확인 중...');
    const ifRes = await shellCmd('ifconfig');
    if (!ifRes.success || !(ifRes.stdout || '').includes('bridge0')) {
      fail('bridge0', '네트워크 인터페이스 오류');
    } else {
      this._setRow('bridge0', 'ok', '확인됨');
    }

    // ── 6. IPv4 Ping ─────────────────────────────────────────────────
    if (!hasV4) {
      this._setRow('ping4', 'skip', 'IPv4 미할당 — 건너뜀');
    } else {
      this._setRow('ping4', 'running', '확인 중...');
      const p4    = await shellCmd('ping -c 3 -W 3 8.8.8.8 2>&1');
      const p4out = (p4.stdout || '') + (p4.stderr || '');
      const p4ok  = /bytes from/i.test(p4out) ||
        (/(\d+)\s+received/i.test(p4out) &&
         parseInt((p4out.match(/(\d+)\s+received/i) || [])[1] || '0') > 0);
      if (p4ok) {
        const m4 = p4out.match(/\/(\d+(?:\.\d+)?)\/[\d.]+\s*ms/);
        this._setRow('ping4', 'ok', m4 ? `avg ${m4[1]} ms` : '응답 있음');
      } else {
        fail('ping4', 'IPv4 Ping 실패');
      }
    }

    // ── 7. IPv6 Ping ─────────────────────────────────────────────────
    if (!hasV6) {
      this._setRow('ping6', 'skip', 'IPv6 미할당 — 건너뜀');
    } else {
      this._setRow('ping6', 'running', '확인 중...');
      const p6    = await shellCmd('ping6 -c 3 -W 3 2001:4860:4860::8888 2>&1');
      const p6out = (p6.stdout || '') + (p6.stderr || '');
      const p6ok  = /bytes from/i.test(p6out) ||
        (/(\d+)\s+received/i.test(p6out) &&
         parseInt((p6out.match(/(\d+)\s+received/i) || [])[1] || '0') > 0);
      if (p6ok) {
        const m6 = p6out.match(/\/(\d+(?:\.\d+)?)\/[\d.]+\s*ms/);
        this._setRow('ping6', 'ok', m6 ? `avg ${m6[1]} ms` : '응답 있음');
      } else {
        fail('ping6', 'IPv6 Ping 실패');
      }
    }

    // ── 8. ETH WAN 모드 확인 ─────────────────────────────────────────
    this._setRow('eth_wan', 'running', '확인 중...');
    const ethWanRes  = await atCmd('AT*WETHWANENABLE?', 5);
    const ethWanResp = (ethWanRes.response || '');
    const ethWanM    = ethWanResp.match(/WETHWANENABLE\s*:\s*(\d)/i);
    const ethWanVal  = ethWanM ? parseInt(ethWanM[1]) : -1;

    let ethWanEnabled = false;
    if (ethWanVal === 1) {
      ethWanEnabled = true;
      this._setRow('eth_wan', 'ok', 'WAN 모드');
    } else if (ethWanVal === 0) {
      this._setRow('eth_wan', 'ok', 'WAN 모드 아님');
    } else {
      fail('eth_wan', `응답 오류 (${ethWanResp.trim() || '없음'})`);
    }

    // ── 9. ETH WAN IP (eth0.1) ───────────────────────────────────────
    if (!ethWanEnabled) {
      this._setRow('eth_ip',   'skip', 'WAN 모드 아님 — 건너뜀');
      this._setRow('eth_ping', 'skip', 'WAN 모드 아님 — 건너뜀');
      this._verdict(failedSteps.length === 0, failedSteps.length === 0
        ? '✓ 모든 항목 정상' : `✗ 이상 감지: ${failedSteps.join(', ')}`);
      btn.disabled = false;
      return;
    }

    this._setRow('eth_ip', 'running', '확인 중...');
    const ethIfRes  = await shellCmd('ifconfig eth0.1');
    const ethIfOut  = ethIfRes.stdout || '';

    // IPv4 파싱 (inet addr:x.x.x.x 또는 inet x.x.x.x)
    const eth4M = ethIfOut.match(/inet(?:\s+addr:?)\s*([\d.]+)/i);
    const eth4ip = eth4M ? eth4M[1].trim() : '';

    // IPv6 파싱 (inet6 addr: x::x/xx 또는 inet6 x::x)
    const eth6M  = ethIfOut.match(/inet6(?:\s+addr:?)?\s*([0-9a-f:]+)(?:\/\d+)?/i);
    const eth6ip = eth6M ? eth6M[1].trim() : '';

    const hasEthPubV4 = _isPublicV4(eth4ip);
    const hasEthPubV6 = _isPublicV6(eth6ip);

    if (!hasEthPubV4 && !hasEthPubV6) {
      fail('eth_ip', eth4ip || eth6ip
        ? `공인 IP 없음 (${[eth4ip, eth6ip].filter(Boolean).join(', ')})`
        : 'IP 미할당');
      this._setRow('eth_ping', 'skip', 'IP 없음 — 건너뜀');
    } else {
      const ethIpLabel = [
        hasEthPubV4 ? eth4ip : null,
        hasEthPubV6 ? eth6ip : null,
      ].filter(Boolean).join(' / ');
      this._setRow('eth_ip', 'ok', ethIpLabel);

      // ── 10. ETH WAN Ping ─────────────────────────────────────────
      this._setRow('eth_ping', 'running', '확인 중...');
      let pingOk = false;
      let pingLabel = '';

      if (hasEthPubV4) {
        const pr   = await shellCmd('ping -c 3 -W 3 -I eth0.1 8.8.8.8 2>&1');
        const pout = (pr.stdout || '') + (pr.stderr || '');
        pingOk = /bytes from/i.test(pout) ||
          (/(\d+)\s+received/i.test(pout) &&
           parseInt((pout.match(/(\d+)\s+received/i) || [])[1] || '0') > 0);
        if (pingOk) {
          const pm = pout.match(/\/(\d+(?:\.\d+)?)\/[\d.]+\s*ms/);
          pingLabel = pm ? `avg ${pm[1]} ms (IPv4)` : '응답 있음 (IPv4)';
        }
      }

      if (!pingOk && hasEthPubV6) {
        const pr   = await shellCmd(`ping6 -c 3 -W 3 -I eth0.1 ${eth6ip} 2>&1`);
        const pout = (pr.stdout || '') + (pr.stderr || '');
        pingOk = /bytes from/i.test(pout) ||
          (/(\d+)\s+received/i.test(pout) &&
           parseInt((pout.match(/(\d+)\s+received/i) || [])[1] || '0') > 0);
        if (pingOk) {
          const pm = pout.match(/\/(\d+(?:\.\d+)?)\/[\d.]+\s*ms/);
          pingLabel = pm ? `avg ${pm[1]} ms (IPv6)` : '응답 있음 (IPv6)';
        }
      }

      if (pingOk) {
        this._setRow('eth_ping', 'ok', pingLabel);
      } else {
        fail('eth_ping', 'ETH WAN Ping 실패');
      }
    }

    // ── 최종 결과 ────────────────────────────────────────────────────
    if (failedSteps.length > 0) {
      this._verdict(false, `✗ 이상 감지: ${failedSteps.join(', ')}`);
    } else {
      this._verdict(true, '✓ 모든 항목 정상');
    }
    btn.disabled = false;
  },
};
