(function () {
  var DEFAULT = 30, MIN = 16, MAX = 50, STEP = 1;
  // Key แยกตามหน้า เช่น app_fs:/patients.html
  var KEY = 'app_fs:' + window.location.pathname;

  function getSaved() {
    var v = parseInt(localStorage.getItem(KEY));
    return (v >= MIN && v <= MAX) ? v : DEFAULT;
  }

  // Pages with overflow:hidden on <html> need height compensation when zooming
  var _isFixed = null;
  function isFixedPage() {
    if (_isFixed !== null) return _isFixed;
    _isFixed = window.getComputedStyle(document.documentElement).overflow === 'hidden';
    return _isFixed;
  }

  function applySize(px) {
    px = Math.max(MIN, Math.min(MAX, parseInt(px) || DEFAULT));
    var scale = px / DEFAULT;

    // Zoom body — scales EVERYTHING proportionally (text, widths, padding, gaps)
    document.body.style.zoom = scale;

    // For fixed-height pages (overflow:hidden), shrink body pre-zoom so it
    // renders exactly 100vh after scaling. e.g. zoom=1.2 → set height=83.33vh
    // so 83.33vh × 1.2 = 100vh visible with no gap or overflow.
    if (isFixedPage()) {
      document.body.style.height = (100 / scale).toFixed(4) + 'vh';
      document.body.style.overflowX = 'hidden';
    }

    // Keep --app-fs at baseline so existing calc(var(--app-fs)*ratio) rules
    // stay at their intended ratios — zoom then scales the result.
    document.documentElement.style.setProperty('--app-fs', '30px');

    localStorage.setItem(KEY, px);

    var val = document.getElementById('_fsVal');
    var sld = document.getElementById('_fsSlider');
    if (val) val.textContent = px + 'px';
    if (sld) sld.value = px;
  }

  function createWidget() {
    if (document.getElementById('_fsWidget')) return;
    var sz = getSaved();

    var w = document.createElement('div');
    w.id = '_fsWidget';
    w.innerHTML =
      '<style>' +
      '#_fsWidget{position:fixed;bottom:20px;right:20px;z-index:2147483647;' +
        'display:flex;flex-direction:column;align-items:flex-end;gap:8px;}' +
      '#_fsPanel{background:#fff;border:2px solid #90c4e8;border-radius:14px;' +
        'padding:12px 16px;box-shadow:0 6px 24px rgba(0,0,0,.28);width:200px;display:none;}' +
      '#_fsWidget,#_fsWidget *{font-size:14px!important;font-family:sans-serif!important;' +
        'color:#333!important;line-height:1.4!important;box-sizing:border-box!important;' +
        'letter-spacing:normal!important;}' +
      '#_fsPLbl{font-weight:700;color:#1a3a5c!important;display:flex;align-items:center;' +
        'gap:6px;margin-bottom:8px;}' +
      '#_fsPLbl i{font-size:15px!important;color:#2563a8!important;' +
        'font-family:"Font Awesome 6 Free","Font Awesome 6 Brands"!important;}' +
      '#_fsSlider{width:100%;margin:6px 0 2px;accent-color:#2563a8;cursor:pointer;}' +
      '#_fsRowNum{display:flex;justify-content:space-between;align-items:baseline;' +
        'margin-top:2px;}' +
      '#_fsRowNum .fs-sm{font-size:11px!important;}' +
      '#_fsRowNum .fs-lg{font-size:20px!important;line-height:1!important;}' +
      '#_fsVal{font-weight:700;color:#2563a8!important;}' +
      '#_fsReset{margin-top:10px;width:100%;background:#e8f4ff;' +
        'border:1.5px solid #90c4e8;border-radius:8px;padding:5px 0;' +
        'cursor:pointer;color:#1a3a5c!important;font-weight:600;}' +
      '#_fsReset:hover{background:#bee3f8;}' +
      '#_fsToggle{background:linear-gradient(135deg,#1a3a5c,#2563a8);border:none;' +
        'border-radius:50%;width:46px;height:46px;cursor:pointer;' +
        'box-shadow:0 3px 12px rgba(0,0,0,.35);display:flex;align-items:center;' +
        'justify-content:center;flex-shrink:0;transition:opacity .15s;}' +
      '#_fsToggle:hover{opacity:.85;}' +
      '#_fsToggle i{font-size:20px!important;color:#fff!important;' +
        'font-family:"Font Awesome 6 Free","Font Awesome 6 Brands"!important;}' +
      '</style>' +
      '<div id="_fsPanel">' +
        '<div id="_fsPLbl"><i class="fas fa-font"></i>ขนาดตัวอักษร</div>' +
        '<input type="range" id="_fsSlider"' +
          ' min="' + MIN + '" max="' + MAX + '" step="' + STEP + '" value="' + sz + '">' +
        '<div id="_fsRowNum">' +
          '<span class="fs-sm">ก เล็ก</span>' +
          '<span id="_fsVal">' + sz + 'px</span>' +
          '<span class="fs-lg">ก ใหญ่</span>' +
        '</div>' +
        '<button id="_fsReset">ค่าเริ่มต้น (' + DEFAULT + 'px)</button>' +
      '</div>' +
      '<button id="_fsToggle" title="ปรับขนาดตัวอักษร">' +
        '<i class="fas fa-font"></i>' +
      '</button>';

    // Append to <html> (outside <body>) so body zoom does NOT affect widget size/position
    document.documentElement.appendChild(w);

    document.getElementById('_fsToggle').addEventListener('click', function () {
      var p = document.getElementById('_fsPanel');
      p.style.display = p.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('_fsSlider').addEventListener('input', function () {
      applySize(parseInt(this.value));
    });

    document.getElementById('_fsReset').addEventListener('click', function () {
      applySize(DEFAULT);
    });
  }

  function init() {
    createWidget();
    applySize(DEFAULT); // always start at 100% regardless of saved preference
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
