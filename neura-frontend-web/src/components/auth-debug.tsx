"use client";

import { useAuth } from "./google-auth-provider";

export function AuthDebug() {
  const { user, isLoading, error } = useAuth();

  return (
    <div
      className="fixed bottom-4 right-4 bg-gray-800 text-white p-4 rounded-lg shadow-lg text-xs max-w-xs overflow-auto"
      style={{ maxHeight: "300px", zIndex: 9999 }}
    >
      <h4 className="font-bold mb-2">Auth Debug</h4>

      <div className="mb-2">
        <div className="font-semibold">Loading: </div>
        <div>{isLoading ? "True" : "False"}</div>
      </div>

      {error && (
        <div className="mb-2">
          <div className="font-semibold text-red-400">Error: </div>
          <div>{error}</div>
        </div>
      )}

      <div className="mb-2">
        <div className="font-semibold">User: </div>
        <div>{user ? "Authenticated" : "Not authenticated"}</div>
      </div>

      {user && (
        <div className="mt-2 pt-2 border-t border-gray-600">
          <div className="mb-1">
            <span className="font-semibold">Email:</span> {user.email}
          </div>
          <div className="mb-1">
            <span className="font-semibold">Name:</span> {user.displayName}
          </div>
          {user.photoURL && (
            <div className="mt-2">
              <img
                src={user.photoURL}
                alt="Profile"
                className="w-8 h-8 rounded-full"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
