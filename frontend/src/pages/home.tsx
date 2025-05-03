import { RoomComponent } from "../components/room-component";
import { HeaderMain } from "../components/header-main";
import { useEffect } from "react";
import { useNavigate } from 'react-router';
import { ROUTE_PATHS } from "../main";
import { useAuth } from "../hooks/useAuth";

export default function Dashboard() {
  const navigate = useNavigate();
  const {user, loading} = useAuth();

  // Redirect if already logged out
  useEffect(() => {
    if (!user && !loading) {
      navigate(ROUTE_PATHS.LOGIN);
    }
  }, [user, loading, navigate]);

  return user && (
    <div className="flex flex-col h-full bg-neutral-100">
      <HeaderMain />
      <main className="flex flex-col flex-grow overflow-hidden p-0 md:p-2 md:pt-0 w-full md:mx-auto">
        <RoomComponent />
      </main>
      <footer className="hidden md:flex md:items-center md:gap-2 md:justify-center font-mono uppercase text-right pt-1 pb-2 px-8 text-xs text-gray-600 w-full md:mx-auto">
        © {new Date().getFullYear()} Mclean Capital
      </footer>
    </div>
  );
}
