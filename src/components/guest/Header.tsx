import logo from '@/assets/logo.jpg';

export function Header() {
  return (
    <header className="sticky top-0 z-50 bg-primary/95 backdrop-blur supports-[backdrop-filter]:bg-primary/90 shadow-md">
      <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-center gap-3">
        <img src={logo} alt="OC Adventure Homes" className="h-10 w-auto rounded" />
        <div className="h-6 w-px bg-primary-foreground/30" />
        <h1 className="text-base font-semibold text-primary-foreground tracking-wide">Pool Heat Booking</h1>
      </div>
    </header>
  );
}
