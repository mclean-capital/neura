import { RoomComponent } from "../components/room-component";
import { HeaderMain } from "../components/header-main";

export default function Dashboard() {
  return (
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
