"use client";
import { FirebaseApp, initializeApp } from "firebase/app";
import {
  Auth,
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User,
} from "firebase/auth";

// --- Firebase Configuration ---
const firebaseConfig = {
  apiKey: "AIzaSyDA_o4IBmtXWVfi_39euyU3gnntHMt20BQ",
  authDomain: "neura-20293.firebaseapp.com",
  projectId: "neura-20293",
  storageBucket: "neura-20293.firebasestorage.app",
  messagingSenderId: "785551987611",
  appId: "1:785551987611:web:55c162aab2e3619e67873e",
};

// --- Initialize Firebase and Auth ---
// Check if already initialized (useful for HMR in development)
let app: FirebaseApp;
let auth: Auth;
let googleProvider: GoogleAuthProvider;

try {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  googleProvider = new GoogleAuthProvider();
  // Add scopes for Google sign-in
  googleProvider.addScope("https://www.googleapis.com/auth/userinfo.email");
  googleProvider.addScope("https://www.googleapis.com/auth/userinfo.profile");
  console.log("Firebase initialized successfully.");
} catch (error) {
  // Handle potential initialization errors (e.g., duplicate app)
  // In a real app, you might want more robust error handling or logging
  console.warn("Firebase initialization error/already initialized:", error);
  // Attempt to get existing instances if initialization failed due to duplication
  // This part might need adjustment based on specific Firebase error types
  // For simplicity, we'll assume getAuth() works even if initializeApp throws duplicate error
  auth = getAuth();
  googleProvider = new GoogleAuthProvider(); // Re-initialize provider if needed
  googleProvider.addScope("https://www.googleapis.com/auth/userinfo.email");
  googleProvider.addScope("https://www.googleapis.com/auth/userinfo.profile");
}

// --- Exported Auth Functions ---

// Sign in with Google using redirect (to avoid COOP issues)
const signInWithGoogle = async (): Promise<User> => {
  try {
    const result = await signInWithPopup(auth, googleProvider);

    // TODO: handle this on server later
    const ALLOWED_EMAILS = [
      "donmcleanx@gmail.com",
      "don.mclean@mcleancaptial.org",
      "reign@mcleancaptial.org",
    ];

    if (!ALLOWED_EMAILS.includes(result.user?.email || "")) {
      signOut(auth);
      throw new Error("You're not welcomed here ;)");
    }

    return result.user;
  } catch (error) {
    console.error("Error signing in with Google:", error);
    throw error; // Re-throw the error to be handled by the caller
  }
};

// Sign out current user
const signOutUser = async (): Promise<void> => {
  try {
    await signOut(auth);
  } catch (error) {
    console.error("Error signing out:", error);
    throw error;
  }
};

// Get current authenticated user (direct access)
const getCurrentUser = (): User | null => {
  return auth.currentUser;
};

// Subscribe to auth state changes
const subscribeToAuthState = (
  callback: (user: User | null) => void
): (() => void) => {
  // Return the unsubscribe function directly
  return onAuthStateChanged(auth, callback);
};

// --- Exports ---
export {
  auth, // Export the auth instance directly
  googleProvider,
  signInWithGoogle,
  signOutUser,
  getCurrentUser,
  subscribeToAuthState,
  // Export User type if needed elsewhere
  type User,
};

// Note: Consider moving API keys and sensitive config to environment variables (.env.local)
// Example: apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY
