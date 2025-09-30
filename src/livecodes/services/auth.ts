/* eslint-disable @typescript-eslint/no-empty-function */
import type { GithubScope, User } from '../models';
import { decrypt, encrypt } from '../storage';

// --- CONFIGURATION CONSTANTS (MUST BE SET VIA ENVIRONMENT/BUILD PROCESS IN REAL APP) ---
// Note: Client Secret is NOT required for the Device Flow exchange!
const GITHUB_CLIENT_ID = 'YOUR_GITHUB_CLIENT_ID';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
// IMPORTANT: This proxy is used to circumvent GitHub's CORS policy. 
// We are switching to a new proxy URL to try and resolve the 404 error.
// WARNING: This is for development/testing only. Use a secure backend for production.
const CORS_PROXY = 'https://thingproxy.freeboard.io/fetch/'; 
// ---------------------------------------------------------------------------------------

interface AuthService {
  load(): Promise<void>;
  getUser(): Promise<User | void>;
  signIn(scopes?: GithubScope[]): Promise<User | void>;
  signOut(): Promise<void>;
  isLoggedIn(): boolean;
}

const fakeAuthService: AuthService = {
  load: async () => {},
  getUser: async () => {},
  signIn: async () => {},
  signOut: async () => {},
  isLoggedIn: () => false,
};

// Internal state to hold user data
let currentUser: User | null = null;
let isAuthenticated = false;

// Function to handle the polling loop (must be defined outside the service for cleaner recursion)
const pollForToken = (
  deviceCode: string, 
  interval: number, 
  resolve: (user: User | void) => void, 
  reject: (error: Error) => void,
  startTime: number
) => {
  const timeout = setTimeout(async () => {
    // Check for expiration (GitHub usually expires in 10 minutes)
    if (Date.now() - startTime > 600000) { // 10 minutes (600,000 ms)
        clearTimeout(timeout);
        console.error('!!! Auth Error: Device code expired (10 minute limit reached). Please try signing in again.');
        reject(new Error('Device code expired.'));
        return;
    }

    try {
      // Use the new proxy for the token request
      const proxiedAccessTokenUrl = CORS_PROXY + ACCESS_TOKEN_URL;

      const response = await fetch(proxiedAccessTokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });

      const result = await response.json();

      if (result.access_token) {
        // SUCCESS! Authorization granted.
        clearTimeout(timeout);
        const token = result.access_token;
        console.log('--- Auth Debug: Access token received successfully!');
        
        const tempUid = 'github-' + Math.random().toString(36).substring(2, 10); 
        await saveToken(tempUid, token);

        const userInfo = await fetchUserName(tempUid); 
        
        const user: User = {
          uid: tempUid,
          displayName: userInfo.displayName,
          username: userInfo.username,
          email: userInfo.email,
          photoURL: userInfo.photoURL,
          token: token,
        };

        currentUser = user;
        isAuthenticated = true;
        resolve(user);

      } else if (result.error === 'authorization_pending') {
        // User hasn't finished yet. Continue polling.
        console.log('--- Auth Debug: Waiting for user authorization...');
        pollForToken(deviceCode, interval, resolve, reject, startTime);

      } else if (result.error === 'slow_down') {
        // GitHub asked us to poll slower. Adjust interval.
        const newInterval = interval + 5000; // Increase by 5 seconds
        console.warn('--- Auth Warning: Slowing down polling interval to', newInterval, 'ms');
        pollForToken(deviceCode, newInterval, resolve, reject, startTime);

      } else if (result.error === 'access_denied') {
        // User declined the authorization.
        clearTimeout(timeout);
        console.error('!!! Auth Error: Access denied by user.');
        reject(new Error('Access denied by user.'));

      } else if (result.error === 'expired_token') {
        // Authorization window passed.
        clearTimeout(timeout);
        console.error('!!! Auth Error: Device code expired (10 minute limit reached). Please try signing in again.');
        reject(new Error('Device code expired.'));

      } else {
        // Any other error.
        clearTimeout(timeout);
        console.error('!!! Auth Error: Unknown polling error:', result.error_description || result.error);
        reject(new Error(result.error_description || 'Unknown authentication error.'));
      }
    } catch (error) {
      clearTimeout(timeout);
      console.error('!!! Auth Error: Network failure during token polling.', error);
      reject(error as Error);
    }
  }, interval * 1000); // interval is in seconds
};


export const createAuthService = (isEmbed: boolean): AuthService => {
  if (isEmbed) return fakeAuthService;

  const authService: AuthService = {
    async load() {
      // Load existing user data if a token is present in localStorage
      const existingUid = localStorage.getItem('current_uid');
      if (existingUid) {
        const token = await getToken(existingUid);
        if (token) {
          // Re-fetch user info using existing token to ensure cached data is fresh
          await fetchUserName(existingUid); 
          
          // Use the utility function to construct the user object, resolving the TS error
          currentUser = await getUserInfo({ uid: existingUid });
          isAuthenticated = true;
        }
      }
    },
    async getUser(): Promise<User | void> {
      if (isAuthenticated && currentUser) {
        return currentUser;
      }
      return undefined;
    },
    async signIn(scopes: GithubScope[] = ['gist', 'repo']): Promise<User | void> {
      try {
        console.log('--- Auth Debug: Requesting Device Code from GitHub...');
        
        // 1. Request the device and user codes
        const scopeString = scopes.join(' ');
        
        // Use the new proxy for the initial device code request
        const proxiedDeviceCodeUrl = CORS_PROXY + DEVICE_CODE_URL;

        const response = await fetch(proxiedDeviceCodeUrl, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Accept': 'application/json' // Request JSON response
          },
          body: JSON.stringify({
            client_id: GITHUB_CLIENT_ID,
            scope: scopeString
          })
        });

        if (!response.ok) {
           // If the proxy returns a 404, we catch it here.
           let errorMessage = `Device code request failed: ${response.status} - ${response.statusText}`;
           try {
               const errorBody = await response.json();
               errorMessage += ` (${errorBody.error || errorBody.message || 'No details'})`;
           } catch {}
           throw new Error(errorMessage);
        }

        const result = await response.json();

        const { 
          device_code, 
          user_code, 
          verification_uri, 
          interval 
        } = result;

        if (!device_code || !user_code || !verification_uri) {
            throw new Error('Missing required codes from GitHub response.');
        }

        // 2. Instruct the user (using console since we can't show a custom modal)
        console.log(
          '========================================================================================\n',
          '| 🐙 GITHUB SIGN IN REQUIRED |\n',
          '| 1. Open this URL in a new tab: ', verification_uri, '\n',
          '| 2. Enter the following code when prompted: ', user_code, '\n',
          '| 3. Click "Authorize" on the GitHub page.\n',
          '| (This window will automatically poll for successful sign-in every', interval, 'seconds)\n',
          '========================================================================================'
        );
        
        // 3. Start the polling loop
        return new Promise((resolve, reject) => {
            pollForToken(device_code, interval, resolve, reject, Date.now());
        });

      } catch (error) {
        console.error('!!! Auth Error: Failed to initiate GitHub Device Flow.', error);
        return;
      }
    },
    async signOut() {
      deleteUserData(currentUser?.uid);
      currentUser = null;
      isAuthenticated = false;
    },
    isLoggedIn() {
      return isAuthenticated;
    },
  };
  
  return authService;
};

// --- CORE UTILITY FUNCTIONS ---

const saveToken = async (uid: string, token: string) => {
  localStorage.setItem('token_' + uid, await encrypt(token));
  localStorage.setItem('current_uid', uid); // Track the current user
};

const getToken = async (uid?: string) => {
  if (!uid) return null;
  const token = localStorage.getItem('token_' + uid);
  if (!token) return null;
  return decrypt(token);
};

const saveUsername = (uid: string, username: string, email: string, photoURL: string) => {
  localStorage.setItem('username_' + uid, username);
  localStorage.setItem('email_' + uid, email);
  localStorage.setItem('photoURL_' + uid, photoURL);
};

const deleteUserData = (uid?: string) => {
  if (!uid) return;
  localStorage.removeItem('token_' + uid);
  localStorage.removeItem('username_' + uid);
  localStorage.removeItem('email_' + uid);
  localStorage.removeItem('photoURL_' + uid);
  localStorage.removeItem('current_uid');
};

const getUserInfo = async (user: { uid: string }): Promise<User> => ({
  uid: user.uid,
  displayName: localStorage.getItem('username_' + user.uid) || '',
  username: localStorage.getItem('username_' + user.uid) || '',
  email: localStorage.getItem('email_' + user.uid) || '',
  photoURL: localStorage.getItem('photoURL_' + user.uid) || '',
  token: await getToken(user.uid),
});


const fetchUserName = async (uid: string) => {
  const token = await getToken(uid);
  if (!token) {
    console.warn('!!! Sync Warning: Cannot fetch username. Token is missing.');
    return { username: '', displayName: '', email: '', photoURL: '' };
  }

  try {
    console.log('--- Auth Debug: Attempting to fetch GitHub username with token...');
    // We do NOT proxy this call since the GitHub /user API is CORS-enabled.
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: 'token ' + token,
      },
    });

    if (!response.ok) {
      console.error(`!!! Sync Error: GitHub API call failed with status ${response.status} (${response.statusText})`);
      throw new Error(`GitHub user API failed: ${response.status}`);
    }

    const userInfo = await response.json();
    const login = userInfo.login || '';
    const email = userInfo.email || '';
    const photoURL = userInfo.avatar_url || '';
    
    if (!login) {
        console.error('!!! Sync Error: GitHub API response was successful but did not contain a "login" field.', userInfo);
    }

    console.log('--- Auth Debug: GitHub username fetched successfully:', login);
    saveUsername(uid, login, email, photoURL);
    return { username: login, displayName: userInfo.name || login, email, photoURL };

  } catch (error) {
    console.error('!!! Sync Error: Failed to fetch GitHub user info.', error);
    return { username: '', displayName: '', email: '', photoURL: '' };
  }
};
