import { Waves } from 'lucide-react';

export function Header() {
  return (
    <header className="sticky top-0 z-50 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 border-b">
      <div className="max-w-lg mx-auto px-4 py-3 flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
          <Waves className="w-5 h-5 text-primary-foreground" />
        </div>
        <h1 className="text-lg font-bold text-foreground">Pool Heat Checkout</h1>
      </div>
    </header>
  );
}
