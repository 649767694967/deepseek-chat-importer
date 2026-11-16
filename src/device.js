/* ================= 设备识别（手机 / 平板 / 电脑） =================
 * 内联在 <head> 里、样式之前执行，首帧就带正确的 data-device，避免闪一下桌面布局。
 * app.js 复用同一个函数，并在窗口尺寸/旋转/分屏变化时重新判定。
 */
(function () {
  function mq(q) {
    try {
      return window.matchMedia(q).matches;
    } catch (e) {
      return false;
    }
  }

  function detectDevice() {
    var ua = navigator.userAgent || '';
    var w = window.innerWidth || document.documentElement.clientWidth || 1024;
    var touch = (navigator.maxTouchPoints || 0) > 0;
    var coarse = mq('(pointer: coarse)');
    var noHover = mq('(hover: none)');

    var UA_PHONE = /iPhone|iPod/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua));
    var UA_TABLET =
      /iPad/i.test(ua) ||
      (/Macintosh/i.test(ua) && touch) ||
      (/Android/i.test(ua) && !/Mobile/i.test(ua)) ||
      /Tablet|PlayBook|Silk|Kindle/i.test(ua);
    var UA_DESKTOP = /Windows NT|Macintosh|X11|CrOS/i.test(ua) && !UA_PHONE && !UA_TABLET;

    // 1) 先按 UA 定基础类别
    var base = UA_PHONE
      ? 'phone'
      : UA_TABLET
        ? 'tablet'
        : UA_DESKTOP
          ? 'desktop'
          : touch && (coarse || noHover)
            ? 'tablet'
            : 'desktop';

    // 2) 再按当前可用宽度修正：窄窗口 / 分屏 / 小窗都用更紧凑的一档
    var device = base;
    if (w < 600) device = 'phone';
    else if (w < 900 && base === 'desktop' && (touch || coarse || noHover)) device = 'tablet';

    return device;
  }

  function label(device) {
    return device === 'phone' ? '手机' : device === 'tablet' ? '平板' : '电脑';
  }

  window.__DS2CB_DEVICE__ = { detect: detectDevice, label: label, current: null };
  window.__DS2CB_DEVICE__.current = detectDevice();
  document.documentElement.setAttribute('data-device', window.__DS2CB_DEVICE__.current);
})();
