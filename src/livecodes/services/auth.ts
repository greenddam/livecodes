/* eslint-disable @typescript-eslint/no-empty-function */
import type { GithubScope, User } from '../models';
import { decrypt, encrypt } from '../storage';

// --- CONFIGURATION CONSTANTS ---
// We have switched to using a Personal Access Token (PAT) for client-side authentication 
// because all server-based OAuth flows (Authorization Code and Device Flow) are blocked 
// by CORS/security policies in a pure browser environment without a secure backend.
// Removed GITHUB_CLIENT_ID as it is no longer used for PAT authentication.
// Placeholder for the manually generated PAT
const MANUAL_PAT_TOKEN = 'PASTE_YOUR_GITHUB_PERSONAL_ACCESS_TOKEN_HERE'; 
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
          
          // Use the utility function to construct the user object
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
      console.warn('--- Auth Warning: GitHub OAuth flows failed due to network security constraints (CORS/Certificates).');
      
      const pat = MANUAL_PAT_TOKEN.trim();
      
      if (pat === 'PASTE_YOUR_GITHUB_PERSONAL_ACCESS_TOKEN_HERE' || pat === '') {
        console.error(
          '========================================================================================\n',
          '| 🛑 AUTHENTICATION REQUIRED |\n',
          '| To proceed without a backend server, you must use a Personal Access Token (PAT). |\n',
          '| 1. Go to your GitHub settings -> Developer settings -> Personal access tokens. |\n',
          '| 2. Generate a new token with the required scopes (', scopes.join(', '), '). |\n',
          '| 3. Replace the value of the MANUAL_PAT_TOKEN constant in the code with your new token. |\n',
          '| 4. Try signing in again.\n',
          '========================================================================================'
        );
        return; 
      }

      // Declare tempUid outside the try block so it is accessible in the catch block
      let tempUid = '';
      try {
        tempUid = 'pat-user-' + Math.random().toString(36).substring(2, 10); 
        await saveToken(tempUid, pat);

        const userInfo = await fetchUserName(tempUid); 
        
        const user: User = {
          uid: tempUid,
          displayName: userInfo.displayName,
          username: userInfo.username,
          email: userInfo.email,
          photoURL: userInfo.photoURL,
          token: pat,
        };

        currentUser = user;
        isAuthenticated = true;
        console.log('--- Auth Debug: Successfully signed in using Personal Access Token (PAT).');
        return user;
        
      } catch (error) {
        console.error('!!! Auth Error: PAT failed or user info fetch failed. Check if token is valid and has correct scopes.', error);
        // Clean up the invalid token attempt using the now-scoped tempUid
        deleteUserData(tempUid); 
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
    // This call is CORS-enabled, so no proxy is needed.
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
