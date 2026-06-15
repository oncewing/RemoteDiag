/**
 * 디바이스 정보 엔진
 *
 * 자동점검 엔진과 동일한 구조.
 * 프로파일의 devinfo_component 필드로 컴포넌트를 동적 로드.
 *
 * 컴포넌트 인터페이스:
 *   export default {
 *     mount(container, ctx) { ... },
 *     unmount()              { ... },
 *   }
 */

const _BASE = new URL('../..', import.meta.url).pathname.replace(/\/?$/, '/');

const DevInfoEngine = (() => {
  let _current   = null;
  let _container = null;

  function _buildCtx() {
    return {
      atCmd:    (cmd, timeout)  => window._atCmd(cmd, timeout, 'devinfo'),
      shellCmd: (cmd, timeout)  => window._shellCmd(cmd, timeout, 'devinfo'),
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

  async function _fetchProfile(deviceInfo) {
    try {
      const p = new URLSearchParams({ model: deviceInfo.model, customer: deviceInfo.customer });
      const resp = await fetch(`${_BASE}api/diag-profile?${p}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      console.warn('[DevInfoEngine] profile fetch 실패, default 사용:', e);
      return { id: 'default', name: '기본', devinfo_component: 'default.js' };
    }
  }

  async function enter(container) {
    _container = container;

    // 이미 마운트된 상태면 결과 유지
    if (_current) return;

    const ctx = _buildCtx();
    const profile = await _fetchProfile(ctx.deviceInfo);
    const component = profile.devinfo_component || 'default.js';
    console.log('[DevInfoEngine] model:', ctx.deviceInfo.model, '| customer:', ctx.deviceInfo.customer,
                '| profile:', profile.id, '→', component);

    container.innerHTML = '';
    ctx.profile = { id: profile.id, name: profile.name };

    try {
      const mod = await import(`./components/${component}`);
      _current  = mod.default;
      _current.mount(container, ctx);
    } catch (e) {
      container.innerHTML =
        `<div style="padding:20px;color:var(--red)">컴포넌트 로드 실패: ${component}<br>${e}</div>`;
      console.error('[DevInfoEngine] 컴포넌트 로드 오류:', e);
    }
  }

  function leave() {}

  function reset() {
    _current?.unmount?.();
    _current = null;
    if (_container) _container.innerHTML = '';
    console.log('[DevInfoEngine] reset');
  }

  return { enter, leave, reset };
})();

window.DevInfoEngine = DevInfoEngine;
