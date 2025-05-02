"use client";
import { Button } from "../components/ui/button";
import NeuraLogo from "../assets/media/images/logo-512x512.png";
import { useAuth } from "../hooks/useAuth";
import { signOutUser } from "../services/firebase";

export const HeaderMain = () => {
  // Get user from the auth context
  const { user } = useAuth();

  return (
    <header className="flex flex-shrink-0 h-12 items-center justify-between px-4 w-full md:mx-auto">
      <div className="flex items-center gap-3">
        <div className="mx-auto w-10 h-10 rounded-full flex items-center pointer-events-none justify-center">
          <img
            width={100}
            height={100}
            src={NeuraLogo}
            alt="neura logo"
            className="rounded-full"
          />
        </div>
        <h1 className="text-xl font-bold">Neura</h1>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 pointer-events-none">
          {user?.photoURL && (
            <img
              width={100}
              height={100}
              src={user.photoURL}
              alt={user.displayName || user.email || "user"}
              className="w-8 h-8 rounded-full"
            />
          )}
          <span className="text-sm hidden md:inline">
            {user?.displayName || user?.email}
          </span>
        </div>

        {/* Use the imported signOutUser function */}
        <Button onClick={signOutUser}>Logout</Button>
      </div>

      {/* <Auth /> */}
    </header>
  );
};
