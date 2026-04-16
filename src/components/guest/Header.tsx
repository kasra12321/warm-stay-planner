import logoSquare from '@/assets/logo-square.jpg';

export function Header() {
  return (
    <header className="sticky top-0 z-50 bg-primary shadow-md">
      <div className="max-w-lg mx-auto px-4 py-2 flex items-center justify-center">
        <img src={logoSquare} alt="OC Adventure Homes" className="h-12 w-auto rounded-lg" />
      </div>
    </header>
  );
}
