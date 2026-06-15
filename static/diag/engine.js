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
 *   ctx.deviceInfo                → { serial, port, srsdIp, srsdPort, model } (getter)
 */

// engine.js 위치(/static/diag/engine.js) 기준으로 서버 루트 경로 계산
// 예) https://host/remotediag/static/diag/engine.js → /remotediag/
const _BASE = new URL('../..', import.meta.url).pathname.replace(/\/?$/, '/');

const DiagEngine = (() => {
  let _current   = null;
  let _container = null;

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
          model:    window.selectedModel    || '',
          customer: window.selectedCustomer || '',
        };
      },
    };
  }

  /** 프로파일 fetch */
  async function _fetchProfile(deviceInfo) {
    try {
      const p = new URLSearchParams({
        model:    deviceInfo.model,
        customer: deviceInfo.customer,
      });
      const resp = await fetch(`${_BASE}api/diag-profile?${p}`);
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

    // 이미 컴포넌트가 마운트된 상태면 결과 유지 (재마운트 안 함)
    if (_current) return;

    const ctx = _buildCtx();
    const profile = await _fetchProfile(ctx.deviceInfo);
    console.log('[DiagEngine] model:', ctx.deviceInfo.model, '| customer:', ctx.deviceInfo.customer,
                '| profile:', profile.id, '→', profile.component);

    container.innerHTML = '';

    // ctx에 profile 정보 추가 (컴포넌트가 헤더 표시에 활용)
    ctx.profile = { id: profile.id, name: profile.name };

    // 컴포넌트 동적 로드
    try {
      const mod = await import(`./components/${profile.component}`);
      _current  = mod.default;
      _current.mount(container, ctx);
    } catch (e) {
      container.innerHTML =
        `<div style="padding:20px;color:var(--red)">컴포넌트 로드 실패: ${profile.component}<br>${e}</div>`;
      console.error('[DiagEngine] 컴포넌트 로드 오류:', e);
    }
  }

  /** 탭 이탈 — 결과 유지를 위해 unmount 호출하지 않음 */
  function leave() {}

  /** 명시적 초기화 (단말 변경 등 필요 시) */
  function reset() {
    _current?.unmount?.();
    _current = null;
    if (_container) _container.innerHTML = '';
    console.log('[DiagEngine] reset');
  }

  return { enter, leave, reset };
})();

window.DiagEngine = DiagEngine;
