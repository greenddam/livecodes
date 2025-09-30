import { customEvents } from './events/custom-events';
import type { I18nKeyType } from './i18n';
import { clickToLoad, isEmbed, livecodes, loading, params } from './main';
import type { Config, CustomEvents } from './models';

const sdkVersion = params.get('sdkVersion');
const rootSelector = '#livecodes';
const loadingEl = document.querySelector<HTMLElement>('#loading')!;
const loadingText = document.querySelector<HTMLElement>('#loading-text')!;
const loadingHTML = loadingEl.innerHTML;

// --- New: PAT Input Modal Implementation ---

/**
 * Creates and shows a responsive, custom modal dialog to securely prompt
 * the user for a GitHub Personal Access Token (PAT).
 *
 * Note: This implementation simulates using a dedicated UI component
 * and is exposed globally for the auth service to call.
 *
 * @param message The prompt message (e.g., listing required scopes).
 * @returns A promise that resolves with the entered PAT string, or null if canceled.
 */
const createPatInputModal = (message: string): Promise<string | null> => {
  // Since we cannot use 'alert' or 'prompt', we build a simple, clean, custom modal UI.
  const modalHTML = `
    <div id="pat-modal-backdrop" class="fixed inset-0 bg-gray-900 bg-opacity-70 z-[100] flex items-center justify-center transition-opacity duration-300 opacity-0">
      <div class="bg-white max-w-lg w-11/12 p-6 rounded-xl shadow-2xl transform scale-95 transition-transform duration-300">
        <h2 class="text-xl font-bold text-gray-800 mb-3 text-purple-600">
          GitHub Personal Access Token
        </h2>
        <p class="text-sm text-gray-600 mb-4">${message}</p>
        
        <label for="pat-input" class="block text-sm font-medium text-gray-700 mb-1">
          Token:
        </label>
        <input 
          type="password" 
          id="pat-input" 
          class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500 text-sm"
          placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxx"
          autocomplete="off"
        >

        <div class="mt-6 flex justify-end space-x-3">
          <button id="pat-cancel" class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-200 rounded-xl hover:bg-gray-300 transition">Cancel</button>
          <button id="pat-ok" class="px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-xl shadow-md hover:bg-purple-700 transition">Sign In</button>
        </div>
      </div>
    </div>
  `;

  const wrapper = document.createElement('div');
  wrapper.innerHTML = modalHTML;
  const modalEl = wrapper.firstChild;

  return new Promise((resolve) => {
    document.body.appendChild(modalEl);
    
    // Give a moment for the element to be appended before fading it in
    setTimeout(() => {
      modalEl.classList.remove('opacity-0');
      (modalEl.querySelector('.shadow-2xl') as HTMLElement)?.classList.remove('scale-95');
    }, 10);

    const handleClose = (pat: string | null) => {
      modalEl.classList.add('opacity-0');
      (modalEl.querySelector('.shadow-2xl') as HTMLElement)?.classList.add('scale-95');
      setTimeout(() => modalEl.remove(), 300); // Remove after transition
      resolve(pat);
    };

    modalEl.querySelector('#pat-ok')?.addEventListener('click', () => handleClose((modalEl.querySelector('#pat-input') as HTMLInputElement)?.value.trim()));
    modalEl.querySelector('#pat-cancel')?.addEventListener('click', () => handleClose(null));
  });
};

// Expose the implementation globally for the authentication service
(window as any).showPatInputModal = createPatInputModal;

if (isEmbed) {
  parent.postMessage(
    { type: customEvents.init, payload: { appVersion: process.env.VERSION } },
    '*',
  );

  document.body.classList.add('embed');
  if (clickToLoad) {
    loadingEl.classList.add('click-to-load');
    loadingEl.title = 'Click to Load';
    loadingText.innerText = 'Click to load LiveCodes';

    // load on click
    loadingEl.addEventListener('click', load);

    // load from API
    addEventListener('message', (e) => {
      if (e.source === parent && e.data?.type === customEvents.load) {
        load();
      }
    });

    // load on visible
    if (loading === 'lazy' && 'IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        (entries, observer) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              load();
              observer.unobserve(document.body);
            }
          });
        },
        { rootMargin: '150px' },
      );
      observer.observe(document.body);
    }
  }
} else {
  // Splash i18n
  const i18nItem = (item: I18nKeyType) => `i18n_${item}`;
  const i18nLoadingText = localStorage.getItem(i18nItem('splash.loading'));
  if (i18nLoadingText) {
    loadingText.innerText = i18nLoadingText;
  }
}

function load() {
  window.dispatchEvent(new Event(customEvents.load));

  if (!clickToLoad) return;
  loadingEl.style.opacity = '0';
  setTimeout(() => {
    loadingEl.classList.remove('click-to-load');
    loadingEl.innerHTML = loadingHTML;
    loadingEl.title = '';
    loadingEl.style.opacity = '1';
  }, 500);
}

function loaded() {
  loadingEl.style.opacity = '0';
  setTimeout(() => {
    loadingEl.remove();
  }, 500);

  document.querySelector<HTMLElement>(rootSelector)!.style.opacity = '1';
}

function resize() {
  document.body.style.height = window.innerHeight + 'px';
}

resize();
window.addEventListener('resize', resize, false);
setTimeout(resize, 500);

window.addEventListener(customEvents.appLoaded, (e: CustomEventInit) => {
  loaded();
  (window as any).livecodes = e.detail;
});

// window.addEventListener(customEvents.ready, () => {
//   // project loaded
// });

// window.addEventListener(customEvents.change, () => {
//   // content changed
// });

// window.addEventListener(customEvents.testResults, (e: CustomEventInit) => {
//   const testResults = e.detail;
// });

// window.addEventListener(customEvents.console, (e: CustomEventInit) => {
//   const { method, args } = e.detail;
// });

window.addEventListener(customEvents.destroy, () => {
  window.removeEventListener('resize', resize);
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

// for backward-compatibility
if (isEmbed && params.get('config') === 'sdk' && !sdkVersion) {
  addEventListener(
    'message',
    function configHandler(
      e: MessageEventInit<{ type: CustomEvents['config']; payload: Partial<Config> }>,
    ) {
      if (e.source !== parent || e.data?.type !== customEvents.config) return;
      removeEventListener('message', configHandler);
      livecodes('#livecodes', e.data.payload).then(loaded);
    },
  );
  parent.postMessage({ type: customEvents.getConfig }, '*');
} else {
  livecodes('#livecodes').then(loaded);
}
