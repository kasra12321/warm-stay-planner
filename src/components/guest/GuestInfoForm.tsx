import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { GuestInfo } from '@/lib/types';
import { ArrowLeft } from 'lucide-react';

interface Props {
  initial: GuestInfo;
  onSubmit: (info: GuestInfo) => void;
  onBack: () => void;
  homeName: string;
}

export function GuestInfoForm({ initial, onSubmit, onBack, homeName }: Props) {
  const [name, setName] = useState(initial.name);
  const [mobile, setMobile] = useState(initial.mobile);
  const [email, setEmail] = useState(initial.email || '');
  const [errors, setErrors] = useState<{ name?: string; mobile?: string; email?: string }>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: typeof errors = {};
    if (!name.trim()) newErrors.name = 'Name is required';
    if (!mobile.trim()) newErrors.mobile = 'Phone number is required';
    else if (mobile.replace(/\D/g, '').length < 10) newErrors.mobile = 'Enter a valid phone number';
    if (!email.trim()) newErrors.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) newErrors.email = 'Enter a valid email';

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }
    onSubmit({ name: name.trim(), mobile: mobile.trim(), email: email.trim().toLowerCase() });
  };

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="text-center space-y-1">
        <h2 className="text-2xl font-bold text-foreground">Your Information</h2>
        <p className="text-muted-foreground">Booking pool heat for <span className="font-medium text-foreground">{homeName}</span></p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Full Name</Label>
          <Input
            id="name"
            value={name}
            onChange={e => { setName(e.target.value); setErrors(p => ({ ...p, name: undefined })); }}
            placeholder="John Smith"
            className="h-12 text-base"
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="mobile">Mobile Number</Label>
          <Input
            id="mobile"
            type="tel"
            value={mobile}
            onChange={e => { setMobile(e.target.value); setErrors(p => ({ ...p, mobile: undefined })); }}
            placeholder="(555) 123-4567"
            className="h-12 text-base"
          />
          {errors.mobile && <p className="text-sm text-destructive">{errors.mobile}</p>}
          <p className="text-xs text-muted-foreground">We'll text your confirmation here</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={e => { setEmail(e.target.value); setErrors(p => ({ ...p, email: undefined })); }}
            placeholder="you@example.com"
            className="h-12 text-base"
          />
          {errors.email && <p className="text-sm text-destructive">{errors.email}</p>}
          <p className="text-xs text-muted-foreground">We'll email you a receipt with payment details</p>
        </div>

        <Button type="submit" className="w-full h-12 text-base font-semibold">
          Continue to Calendar
        </Button>
      </form>
    </div>
  );
}
