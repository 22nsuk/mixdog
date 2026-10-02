// Run through scripts/dom-eval.mjs in the isolated dev app.
// Measure its real tab CSS/pseudo-elements, not a regex of the stylesheet.
(() => {
  const source = document.querySelector('.workspace-tab');
  if (!source) throw new Error('A real workspace tab must be present before checking alignment.');
  const originalTheme = document.documentElement.getAttribute('data-mixdog-theme');
  const fixture = document.createElement('div');
  fixture.className = 'pane-split';
  Object.assign(fixture.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '600px',
    height: '50px',
    visibility: 'hidden',
    pointerEvents: 'none',
  });
  const shell = document.createElement('div');
  shell.className = 'workspace-tabs-shell';
  const strip = document.createElement('div');
  strip.className = 'workspace-tabs';
  strip.style.display = 'flex';
  const tabs = [0, 1].map(() => {
    const tab = source.cloneNode(true);
    tab.className = 'workspace-tab';
    tab.removeAttribute('id');
    tab.style.transition = 'none';
    strip.append(tab);
    return tab;
  });
  shell.append(strip);
  fixture.append(shell);
  document.body.append(fixture);
  const results = [];
  const require = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  // Blink rounds used dimensions to layout subpixels at fractional zoom.
  // This tolerance covers that rounding, but not the original 1px offset.
  const aligned = (a, b) => Math.abs(a - b) < 1 / 32;
  try {
    for (const theme of ['dark', 'light']) {
      document.documentElement.setAttribute('data-mixdog-theme', theme);
      for (const zoom of [0.8, 1, 1.25]) {
        fixture.style.zoom = String(zoom);
        for (const width of [56, 100, 200]) {
          for (const tab of tabs) tab.style.setProperty('--workspace-tab-current-width', `${width}px`);
          for (const [index, tab] of tabs.entries()) {
            for (const other of tabs) other.classList.toggle('active', other === tab);
            for (const focused of [false, true]) {
              shell.dataset.focused = String(focused);
              const plate = getComputedStyle(tab, '::before');
              const band = getComputedStyle(tab, '::after');
              const label = `${theme} zoom=${zoom} width=${width} index=${index} focused=${focused}`;
              require(aligned(parseFloat(band.height), 2), `${label}: band thickness changed (${band.height})`);
              if (focused) {
                const startGap = parseFloat(band.left) - parseFloat(plate.left);
                const endGap = parseFloat(band.right) - parseFloat(plate.right);
                require(aligned(parseFloat(band.top), parseFloat(plate.top)), `${label}: band floats above the plate`);
                require(aligned(startGap, endGap), `${label}: band is not centered on the plate`);
                require(aligned(startGap, parseFloat(plate.borderTopLeftRadius)), `${label}: corner clearance differs`);
                require(band.backgroundColor !== 'rgba(0, 0, 0, 0)', `${label}: focused band is invisible`);
              } else {
                require(band.backgroundColor === 'rgba(0, 0, 0, 0)', `${label}: unfocused pane is marked`);
              }
              results.push({
                theme,
                zoom,
                width,
                index,
                focused,
                plateTop: plate.top,
                bandTop: band.top,
                plateLeft: plate.left,
                bandLeft: band.left,
                plateRight: plate.right,
                bandRight: band.right,
              });
            }
          }
        }
      }
    }
    return {
      passed: results.length,
      firstTab: results.find((row) => row.focused && row.index === 0),
      laterTab: results.find((row) => row.focused && row.index === 1),
    };
  } finally {
    fixture.remove();
    if (originalTheme === null) document.documentElement.removeAttribute('data-mixdog-theme');
    else document.documentElement.setAttribute('data-mixdog-theme', originalTheme);
  }
})();
