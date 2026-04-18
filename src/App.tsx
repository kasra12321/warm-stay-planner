import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
import AdminLogin from "./pages/AdminLogin";
import AdminLayout from "./pages/AdminLayout";
import AdminOverview from "./pages/admin/AdminOverview";
import AdminHomes from "./pages/admin/AdminHomes";
import AdminOrders from "./pages/admin/AdminOrders";
import AdminSchedule from "./pages/admin/AdminSchedule";
import AdminHeatSettings from "./pages/admin/AdminHeatSettings";
import AdminPaymentSettings from "./pages/admin/AdminPaymentSettings";
import AdminNotificationSettings from "./pages/admin/AdminNotificationSettings";
import AdminIAquaLink from "./pages/admin/AdminIAquaLink";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<AdminOverview />} />
            <Route path="homes" element={<AdminHomes />} />
            <Route path="orders" element={<AdminOrders />} />
            <Route path="schedule" element={<AdminSchedule />} />
            <Route path="heat-settings" element={<AdminHeatSettings />} />
            <Route path="payment-settings" element={<AdminPaymentSettings />} />
            <Route path="notification-settings" element={<AdminNotificationSettings />} />
            <Route path="iaqualink" element={<AdminIAquaLink />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
