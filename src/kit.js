// The app core's theme (app-ui), loaded by URL at one pinned version. style.css imports the same version's theme.css
// and sw.js keeps its files for offline use; test/kit.test.js checks the three agree. If the core cannot load, the app
// opens as before on the NTF kit alone.
export const UI = 'https://core.anawj.com/ui/1.0.0-rc.35/';

export async function startKit() {
  try {
    const { applyTheme } = await import(/* the core, by URL: never bundled */ `${UI}theme/index.js`);
    // NTF wine on the linen ground, look A; the palette goes in the `kit` layer and the page keeps its own light theme.
    applyTheme({ accent: '#633d3c', surface: 'linen', look: 'a', layer: 'kit', ownTheme: true });
  } catch (e) {
    console.warn('App core theme did not load; the app goes on without it.', e);
  }
}
