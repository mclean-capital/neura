"use-client";
// Import the exported auth instance and User type directly
import { auth, User } from "@/services/firebase";
import { useContext, createContext } from "react";
import { useAuthState } from "react-firebase-hooks/auth";

interface AuthContextType {
  user: User | null | undefined;
  loading: boolean;
  error: Error | undefined;
}

const defaultAuth = {
  user: undefined,
  loading: false,
  error: undefined,
};

const AuthContext = createContext<AuthContextType>(defaultAuth);

export const useAuth = () => {
  return useContext(AuthContext);
};

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  // Use the imported auth instance directly
  const [user, loading, error] = useAuthState(auth);

  const value = { user, loading, error };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
