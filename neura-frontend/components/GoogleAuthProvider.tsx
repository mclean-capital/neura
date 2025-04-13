"use client";

import { createContext, useContext, useEffect, useState } from "react";

interface AuthUser {
  email: string;
  name?: string;
  picture?: string;
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  login: (idToken: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function GoogleAuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initialize auth state from localStorage
  useEffect(() => {
    const storedToken = localStorage.getItem("authToken");
    const storedUser = localStorage.getItem("authUser");

    if (storedToken && storedUser) {
      try {
        setToken(storedToken);
        setUser(JSON.parse(storedUser));
      } catch (err) {
        console.error("Error parsing stored user:", err);
        // Clear invalid storage
        localStorage.removeItem("authToken");
        localStorage.removeItem("authUser");
      }
    }

    setIsLoading(false);
  }, []);

  // Verify token with the server
  useEffect(() => {
    if (!token) return;

    const verifyToken = async () => {
      try {
        const response = await fetch("http://localhost:3001/api/auth/verify", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error("Token verification failed");
        }

        const data = await response.json();
        setUser(data.user);
      } catch (err) {
        console.error("Token verification error:", err);
        setError("Authentication expired. Please log in again.");
        logout();
      }
    };

    verifyToken();
  }, [token]);

  const login = async (idToken: string) => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("http://localhost:3001/api/auth/google", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idToken }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Authentication failed");
      }

      const data = await response.json();

      // Store token and user in state and localStorage
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem("authToken", data.token);
      localStorage.setItem("authUser", JSON.stringify(data.user));
    } catch (err) {
      console.error("Login error:", err);
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setIsLoading(false);
    }
  };

  const logout = () => {
    // Clear state
    setToken(null);
    setUser(null);

    // Clear storage
    localStorage.removeItem("authToken");
    localStorage.removeItem("authUser");
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isLoading,
        error,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within a GoogleAuthProvider");
  }
  return context;
}
