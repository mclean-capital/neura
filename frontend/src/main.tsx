import { createBrowserRouter, RouterProvider } from "react-router";
import ReactDOM from "react-dom/client";
import HomePage from "./pages/home";
import LoginPage from "./pages/login";
import "./index.css";
import RootLayout from "./app/layout";

const root = document.getElementById("root");

export const ROUTE_PATHS = {
  HOME: "/",
  LOGIN: "/login",
};

const router = createBrowserRouter([
  {
    path: ROUTE_PATHS.HOME,
    index: true,
    Component: HomePage,
  },
  {
    path: ROUTE_PATHS.LOGIN,
    Component: LoginPage,
  },
]);

ReactDOM.createRoot(root as Element).render(
  <RootLayout>
    <RouterProvider router={router} />
  </RootLayout>
);
// createRoot(document.getElementById("root")!).render(
//   <StrictMode>
//     <App />
//   </StrictMode>
// );
