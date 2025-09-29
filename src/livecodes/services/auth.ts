/* eslint-disable @typescript-eslint/no-empty-function */
import type { GithubScope, User } from '../models';
import { decrypt, encrypt } from '../storage';
import { getImportInstance } from '../utils';

type FirebaseUser = import('firebase/auth').User;
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

export const createAuthService = (isEmbed: boolean): AuthService => {
  // do not allow access to auth in embeds
  if (isEmbed) return fakeAuthService;

  let initializeApp: typeof import('firebase/app').initializeApp;
  let getApp: typeof import('firebase/app').getApp;
  let getAuth: typeof import('firebase/auth').getAuth;
  let signInWithPopup: typeof import('firebase/auth').signInWithPopup;
  let signOut: typeof import('firebase/auth').signOut;
  let GithubAuthProvider: typeof import('firebase/auth').GithubAuthProvider;
  let firebaseConfig: import('firebase/app').FirebaseOptions;
  let firebaseApp: import('firebase/app').FirebaseApp;
  let auth: import('firebase/auth').Auth;
  let currentUser: FirebaseUser | null;

  return {
    async load() {
      const firebase = await getImportInstance('./{{hash:firebase.js}}');

      initializeApp = firebase.initializeApp;
      getApp = firebase.getApp;
      getAuth = firebase.getAuth;
      signInWithPopup = firebase.signInWithPopup;
      signOut = firebase.signOut;
      GithubAuthProvider = firebase.GithubAuthProvider;
      firebaseConfig = firebase.firebaseConfig;

      try {
        firebaseApp = getApp();
      } catch {
        firebaseApp = initializeApp(firebaseConfig);
      }
      auth = getAuth(firebaseApp);
      currentUser = auth.currentUser;
    },
    async getUser(): Promise<User | void> {
      if (!auth) {
        await this.load();
      }
      const token = await getToken(currentUser?.uid);
      if (currentUser) {
        if (!token) return;
        return Promise.resolve(await getUserInfo(currentUser));
      }
      return new Promise((resolve) => {
        const unsubscribe = auth.onAuthStateChanged(async (user: FirebaseUser | null) => {
          if (!user) {
            resolve(undefined);
          } else {
            currentUser = user;
            unsubscribe();
            resolve(await getUserInfo(currentUser));
          }
        });
      });
    },
    async signIn(scopes: GithubScope[] = ['gist', 'repo']): Promise<User | void> {
      if (!auth) {
        await this.load();
      }
      const provider = new GithubAuthProvider();
      scopes.forEach((scope) => provider.addScope(scope));

      try {
        console.log('--- Auth Debug: Initiating GitHub signInWithPopup...');
        const result = await signInWithPopup(auth, provider);
        console.log('--- Auth Debug: signInWithPopup successful. Checking for token...');

        const token = GithubAuthProvider.credentialFromResult(result)?.accessToken;

        if (!token) {
          console.error('!!! Auth Error: FAILED to get access token from Firebase result.');
          console.error('!!! Auth Error: This indicates an issue with the Firebase/GitHub configuration or the OAuth handshake.');
          return;
        }

        console.log('--- Auth Debug: Access token received successfully (length:', token.length, ')');
        
        currentUser = result.user;
        await saveToken(currentUser.uid, token);
        
        // This is the next point of failure to check
        await fetchUserName(currentUser); 
        
        return getUserInfo(result.user);
      } catch (error) {
        console.error('!!! Auth Error: signInWithPopup failed.', error);
        // Firebase Auth errors often have a 'code' and 'message' property
        if ((error as any).code === 'auth/popup-closed-by-user') {
          console.warn('User closed the login popup.');
        }
        return;
      }
    },
    async signOut() {
      if (!auth) {
        await this.load();
      }
      await signOut(auth);
      deleteUserData(currentUser?.uid);
      currentUser = null;
    },
    isLoggedIn() {
      return currentUser != null;
    },
  };
};

const saveToken = async (uid: string, token: string) => {
  localStorage.setItem('token_' + uid, await encrypt(token));
};

const getToken = async (uid?: string) => {
  if (!uid) return null;
  const token = localStorage.getItem('token_' + uid);
  if (!token) return null;
  return decrypt(token);
};

const saveUsername = (uid: string, username: string) => {
  localStorage.setItem('username_' + uid, username);
};

const deleteUserData = (uid?: string) => {
  if (!uid) return;
  localStorage.removeItem('token_' + uid);
  localStorage.removeItem('username_' + uid);
};

const getUserInfo = async (user: FirebaseUser): Promise<User> => ({
  uid: user.uid,
  displayName: user.displayName,
  username: await fetchUserName(user),
  email: user.email,
  photoURL: user.photoURL,
  token: await getToken(user.uid),
});

const fetchUserName = async (user: FirebaseUser) => {
  const uid = user.uid;

  const fromLocalStorage = localStorage.getItem('username_' + uid);
  if (fromLocalStorage) {
    return fromLocalStorage;
  }

  const fromUserInfo = (user as any).reloadUserInfo?.screenName;
  if (fromUserInfo) {
    saveUsername(uid, fromUserInfo);
    return fromUserInfo;
  }

  const token = await getToken(uid);
  if (!token) {
    console.warn('!!! Sync Warning: Cannot fetch username. Token is missing.');
    return '';
  }

  try {
    console.log('--- Auth Debug: Attempting to fetch GitHub username with token...');
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: 'token ' + token, // Use the token received from Firebase
      },
    });

    if (!response.ok) {
      console.error(`!!! Sync Error: GitHub API call failed with status ${response.status} (${response.statusText})`);
      const errorText = await response.text();
      console.error('!!! Sync Error: Response body:', errorText.substring(0, 200) + '...'); // Log part of the error body
      // A 401 error here means the token is invalid or scopes are incorrect/expired.
      throw new Error(`GitHub user API failed: ${response.status}`);
    }

    const userInfo = await response.json();
    const login = userInfo.login;
    
    if (!login) {
        console.error('!!! Sync Error: GitHub API response was successful but did not contain a "login" field.', userInfo);
        return '';
    }

    console.log('--- Auth Debug: GitHub username fetched successfully:', login);
    saveUsername(uid, login);
    return login;

  } catch (error) {
    console.error('!!! Sync Error: Failed to fetch GitHub user info.', error);
    // If the error is network related, this catch block will execute.
    return '';
  }
};
