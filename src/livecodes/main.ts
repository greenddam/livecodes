import { customEvents } from './events/custom-events';
// @ts-ignore
// eslint-disable-next-line import/no-unresolved
import appHTML from './html/app.html?raw';
import type { API, CDN, Config, CustomEvents, EmbedOptions } from './models';
import { modulesService } from './services/modules';
import { isInIframe } from './utils/utils';
import { codeMirrorBaseUrl, esModuleShimsPath } from './vendors';

export type { API, Config };
/**
 * Creates and shows a responsive, custom modal dialog to securely prompt
 * the user for a GitHub Personal Access Token (PAT).
 *
 * This function builds a temporary, self-contained modal element in the DOM
 * using standard HTML/CSS (Tailwind classes) and resolves a Promise based on
 * user action. It is called by the authentication service.
 *
 * @param message The prompt message (e.g., listing required scopes).
 * @returns A promise that resolves with the entered PAT string, or null if canceled.
 */
const createPatInputModal = (message: string): Promise<string | null> => {
  // We use standard DOM manipulation and Tailwind classes for a clean, responsive UI.
  const modalHTML = `
    <!-- Modal Backdrop: Fixed overlay with dim background -->
    <div id="pat-modal-backdrop" class="fixed inset-0 bg-gray-900 bg-opacity-70 z-[100] flex items-center justify-center transition-opacity duration-300 opacity-0">
      <!-- Modal Content Box -->
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
  // Cast to HTMLElement to expose DOM properties like classList, querySelector, and remove()
  const modalEl = wrapper.firstChild as HTMLElement; 

  return new Promise((resolve) => {
    document.body.appendChild(modalEl);
    
    // Add a slight delay to ensure the element is in the DOM before applying fade-in effects
    setTimeout(() => {
      modalEl.classList.remove('opacity-0');
      (modalEl.querySelector('.shadow-2xl') as HTMLElement)?.classList.remove('scale-95');
    }, 10);

    const handleClose = (pat: string | null) => {
      // Start fade-out and shrink transition
      modalEl.classList.add('opacity-0');
      (modalEl.querySelector('.shadow-2xl') as HTMLElement)?.classList.add('scale-95');
      // Remove the element completely after the transition finishes (300ms)
      setTimeout(() => modalEl.remove(), 300);
      resolve(pat);
    };

    const okButton = modalEl.querySelector('#pat-ok');
    const cancelButton = modalEl.querySelector('#pat-cancel');
    const patInput = modalEl.querySelector('#pat-input') as HTMLInputElement | null;

    // Attach event listeners
    okButton?.addEventListener('click', () => handleClose(patInput?.value.trim() ?? null));
    cancelButton?.addEventListener('click', () => handleClose(null));
  });
};

// Expose the implementation globally for the authentication service (called from auth_service.ts)
(window as any).showPatInputModal = createPatInputModal;
export const params = new URLSearchParams(location.search);
const isHeadless =
  (params.get('headless') != null && params.get('headless') !== 'false') ||
  params.get('view') === 'headless'; // for backwards compatibility
const isLite =
  params.get('mode') === 'lite' || (params.get('lite') != null && params.get('lite') !== 'false'); // for backwards compatibility
export let isEmbed =
  isHeadless ||
  isLite ||
  (params.get('embed') != null && params.get('embed') !== 'false') ||
  isInIframe();
const loadingParam = params.get('loading');
export const clickToLoad = isEmbed && loadingParam !== 'eager';
export const loading: EmbedOptions['loading'] = !isEmbed
  ? 'eager'
  : loadingParam === 'lazy' || loadingParam === 'click' || loadingParam === 'eager'
    ? loadingParam
    : 'lazy';

// for backwards compatibility with using extension
export const disableAI =
  (params.get('disableAI') != null && params.get('disableAI') !== 'false') ||
  params.get('enableAI') === 'false';

export const livecodes = (container: string, config: Partial<Config> = {}): Promise<API> =>
  new Promise(async (resolve) => {
    const containerElement = document.querySelector(container);
    if (!containerElement) {
      throw new Error(`Cannot find element with the selector: "${container}"`);
    }
    const baseUrl =
      (location.origin + location.pathname).split('/').slice(0, -1).join('/') + '/livecodes/';

    if (config.mode === 'lite') {
      isEmbed = true;
    }
    const scriptFile = isHeadless
      ? '{{hash:headless.js}}'
      : isEmbed
        ? '{{hash:embed.js}}'
        : '{{hash:app.js}}';

    const anyOrigin = '*';

    const style = document.createElement('style');
    style.innerHTML = `
        ${container} {
            min-width: 300px;
            min-height: 200px;
            padding: 0;
            overflow: hidden;
        }
        ${container} > iframe {
            border: 0;
            width: 100%;
            height: 100%;
        }
        ${container}.embed iframe {
            width: calc(100% - 2px);
            height: calc(100% - 2px);
            border: 1px solid #001b25;
            border-radius: 8px;
        }
    `;
    document.head.appendChild(style);

    const loadApp = async () => {
      const appCDN = await modulesService.checkCDNs(esModuleShimsPath, params.get('appCDN') as CDN);

      const supportsImportMaps = HTMLScriptElement.supports
        ? HTMLScriptElement.supports('importmap')
        : false;

      const iframe = document.createElement('iframe');
      iframe.name = 'app';
      iframe.style.display = 'none';
      const disableAIQuery = disableAI ? `?disableAI` : '';
      iframe.src = './app.html' + disableAIQuery;
      let contentLoaded = false;
      iframe.onload = () => {
        if (contentLoaded) return;
        const appContent = appHTML
          .replace(/{{baseUrl}}/g, baseUrl)
          .replace(/{{script}}/g, scriptFile)
          .replace(/{{appCDN}}/g, appCDN)
          .replace(/{{esModuleShimsUrl}}/g, modulesService.getUrl(esModuleShimsPath, appCDN as CDN))
          .replace(
            /{{codemirrorModule}}/g,
            supportsImportMaps
              ? ''
              : `
    <script type="module">
      import * as mod from '${baseUrl}{{hash:codemirror.js}}';
      window['${baseUrl}{{hash:codemirror.js}}'] = mod;
    </script>
    `,
          )
          .replace(/{{codemirrorCoreUrl}}/g, `${codeMirrorBaseUrl}codemirror-core.js`)
          .replace(/src="[^"]*?\.svg"/g, (str: string) => (isHeadless ? 'src=""' : str))
          .replace(
            /{{codeiumMeta}}/g,
            `<meta name="codeium:type" content="${disableAI ? 'none' : 'monaco'}" />`,
          );

        iframe.contentWindow?.postMessage({ content: appContent }, location.origin);
        contentLoaded = true;
      };
      containerElement.appendChild(iframe);

      if (isEmbed) {
        const registerSDKEvent = (sdkEvent: CustomEvents[keyof CustomEvents], hasData = false) => {
          window.addEventListener(sdkEvent, (e: CustomEventInit) => {
            if (hasData && e.detail == null) return;
            parent.postMessage(
              { type: sdkEvent, ...(hasData ? { payload: e.detail } : {}) },
              anyOrigin,
            );
          });
        };
        registerSDKEvent(customEvents.appLoaded);
        registerSDKEvent(customEvents.ready);
        registerSDKEvent(customEvents.change, true);
        registerSDKEvent(customEvents.testResults, true);
        registerSDKEvent(customEvents.console, true);
        registerSDKEvent(customEvents.destroy);
      }

      let api: API | null = null;

      addEventListener(
        'message',
        async (
          e: MessageEventInit<{ method: keyof API; id: string; args: any; payload?: any }>,
        ) => {
          if (e.data?.args === 'i18n') {
            if (e.source !== iframe.contentWindow) return;

            if (!isEmbed) {
              // flatten i18n object `splash` and save to localStorage
              const i18nSplashData = e.data.payload.data as { [k: string]: string };
              for (const [key, value] of Object.entries(i18nSplashData)) {
                localStorage.setItem(`i18n_splash.${key}`, value);
              }
            }

            // Set document language
            const lang = e.data.payload.lang as string;
            document.documentElement.lang = lang;

            // Reload the page to apply the new language
            const reload = e.data.payload.reload as boolean;
            const appUrl = e.data.payload.url as string | undefined;
            if (reload) {
              const url = new URL(appUrl || location.href);
              if (appUrl && lang) {
                url.searchParams.set('appLanguage', lang);
              } else {
                url.searchParams.delete('appLanguage');
              }
              if (isEmbed) {
                url.searchParams.set('embed', '');
              }
              location.href = url.href;
            }
            return;
          }

          if (isEmbed) {
            if (e.source !== parent || api == null) return;
            const { method, id, args } = e.data ?? {};
            if (!method || !id) return;
            const methodArguments = Array.isArray(args) ? args : [args];
            let payload: any;
            try {
              payload = await (api[method] as any)(...methodArguments);
            } catch (error: any) {
              payload = { error: error.message || error };
            }
            if (typeof payload === 'object') {
              Object.keys(payload).forEach((key) => {
                if (typeof payload[key] === 'function') {
                  delete payload[key];
                }
              });
            }
            parent.postMessage(
              {
                type: customEvents.apiResponse,
                method,
                id,
                payload,
              },
              anyOrigin,
            );
          } else {
            if (e.source !== iframe.contentWindow) return;
            if (e.data?.args === 'home') {
              location.href = location.origin + location.pathname;
            } else if (e.data?.args === 'console-message') {
              // eslint-disable-next-line no-console
              console.info(...(e.data.payload ?? []));
            }
          }
        },
      );

      iframe.addEventListener('load', async () => {
        const app = (iframe.contentWindow as any)?.app;
        if (typeof app === 'function') {
          api = (await app(config, baseUrl)) as API;
          if (!isHeadless) {
            iframe.style.display = 'block';
          }
          window.dispatchEvent(
            new CustomEvent(customEvents.appLoaded, {
              detail: api,
            }),
          );
          resolve(api);
        }
      });
    };

    if (clickToLoad) {
      window.addEventListener(
        customEvents.load,
        () => {
          loadApp();
        },
        { once: true },
      );

      const preloadLink = document.createElement('link');
      preloadLink.href = baseUrl + scriptFile;
      preloadLink.rel = 'preload';
      preloadLink.as = 'script';
      document.head.appendChild(preloadLink);
    } else {
      loadApp();
    }
  });
