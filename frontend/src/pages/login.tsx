"use client";
import { useEffect } from "react";
import NeuraLogo from "../assets/media/images/logo-512x512.png";
import { signInWithGoogle } from "../services/firebase";
import { useAuth } from "../hooks/useAuth";
import { useNavigate } from "react-router";

const LoginPage = () => {
  const { user, loading, error } = useAuth();
  const navigate = useNavigate();

  // Redirect if already logged in
  useEffect(() => {
    if (user && !loading) {
      navigate("/");
    }
  }, [user, loading, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-900">
      <div className="w-full max-w-md p-8 space-y-8 bg-gray-800 rounded-lg shadow-lg">
        <div className="text-center">
          <div className="mx-auto w-20 h-20 rounded-full flex items-center pointer-events-none justify-center">
            <img
              width={200}
              height={200}
              src={NeuraLogo}
              alt="neura logo"
              className="rounded-full"
            />
          </div>
          <h2 className="mt-6 text-3xl font-extrabold text-white">
            Sign in to Neura
          </h2>
          <p className="mt-2 text-sm text-gray-400">Access your personal AI</p>
        </div>

        {error && (
          <div className="bg-red-900/50 border border-red-500 text-white px-4 py-3 rounded relative">
            <strong className="font-bold">Error: </strong>
            <span className="block sm:inline">{error?.message}</span>
          </div>
        )}

        <div className="mt-8 flex flex-col items-center space-y-4">
          {loading ? (
            <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          ) : (
            <button
              onClick={signInWithGoogle} // Use the imported function directly
              className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-md w-full max-w-[280px]"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="#ffffff"
              >
                <path d="M12.545,10.239v3.821h5.445c-0.712,2.315-2.647,3.972-5.445,3.972c-3.332,0-6.033-2.701-6.033-6.032s2.701-6.032,6.033-6.032c1.498,0,2.866,0.549,3.921,1.453l2.814-2.814C17.503,2.988,15.139,2,12.545,2C7.021,2,2.543,6.477,2.543,12s4.478,10,10.002,10c8.396,0,10.249-7.85,9.426-11.748L12.545,10.239z" />
              </svg>
              Continue with Google
            </button>
          )}

          <p className="text-xs text-gray-500 mt-6 text-center">
            Only authorized users can access this application.
          </p>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
