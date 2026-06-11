/**
 * 자동점검 엔진
 *
 * 역할: 단말 정보로 프로파일 조회 → 컴포넌트 동적 로드 → mount/unmount 호출.
 * 컴포넌트 자체 UI/로직에는 관여하지 않는다.
 *
 * 컴포넌트 인터페이스:
 *   export default {
 *     mount(container, ctx) { ... },  // 필수
 *     unmount()              { ... },  // 선택
 *   }
 *
 * ctx 객체:
 *   ctx.atCmd(command, timeout)   → AT 명령 전송 (Promise)
 *   ctx.shellCmd(command, timeout)→ Shell 명령 전송 (Promise)
 *   ctx.connReady(opts)           → 연결 여부 확인 (boolean)
 *   ctx.toast(msg, isError)       → 알림 표시
 *   ctx.deviceInfo                → { serial, port, srsdIp, srsdPort } (getter)
 */

const DiagEngine = (() => {
  let _current   = null;   // 현재 마운트된 컴포넌트
  let _container = null;

  /** app.js 전역을 묶어 ctx 생성 — 매 enter() 호출 시 새로 만든다 */
  function _buildCtx() {
    return {
      atCmd:    (cmd, timeout)  => window._atCmd(cmd, timeout, 'diag'),
      shellCmd: (cmd, timeout)  => window._shellCmd(cmd, timeout, 'diag'),
      connReady:(opts)          => window._connReady(opts),
      toast:    (msg, isError)  => window.toast(msg, isError),
      get deviceInfo() {
        return {
          serial:   window.selectedSerial   || '',
          port:     window.selectedPort     || '',
          srsdIp:   window.selectedSrsdIp   || '',
          srsdPort: window.selectedSrsdPort || 5002,
        };
      },
    };
  }

  /** 프로파일 fetch */
  async function _fetchProfile(deviceInfo) {
    try {
      const p = new URLSearchParams({
        serial:   deviceInfo.serial,
        srsdIp:   deviceInfo.srsdIp,
      });
      const resp = await fetch(`/api/diag-profile?${p}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      console.warn('[DiagEngine] profile fetch 실패, default 사용:', e);
      return { id: 'default', name: '기본 점검', component: 'basic_table.js' };
    }
  }

  /** 탭 진입 */
  async function enter(container) {
    _container = container;
    const ctx     = _buildCtx();
    const profile = await _fetchProfile(ctx.deviceInfo);

    // 이전 컴포넌트 정리
    if (_current) {
      _current.unmount?.();
      _current = null;
    }

    container.innerHTML = '';

    // 컴포넌트 동적 로드
    try {
      const mod = await import(`/static/diag/components/${profile.component}`);
      _current  = mod.default;
      _current.mount(container, ctx);
    } catch (e) {
      container.innerHTML =
        `<div style="padding:20px;color:var(--red)">컴포넌트 로드 실패: ${profile.component}<br>${e}</div>`;
      console.error('[DiagEngine] 컴포넌트 로드 오류:', e);
    }
  }

  /** 탭 이탈 */
  function leave() {
    _current?.unmount?.();
    _current = null;
  }

  return { enter, leave };
})();

window.DiagEngine = DiagEngine;
