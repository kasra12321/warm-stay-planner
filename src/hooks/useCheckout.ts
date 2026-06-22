import { useState, useCallback } from 'react';
import type { Home, GuestInfo, SelectedDate, CheckoutStep, OrderSummary } from '@/lib/types';

export function useCheckout() {
  const [step, setStep] = useState<CheckoutStep>('home');
  const [selectedHome, setSelectedHome] = useState<Home | null>(null);
  const [homeLocked, setHomeLocked] = useState(false);
  const [guestInfo, setGuestInfo] = useState<GuestInfo>({ name: '', mobile: '', email: '' });
  const [selectedDates, setSelectedDates] = useState<SelectedDate[]>([]);
  const [orderSummary, setOrderSummary] = useState<OrderSummary | null>(null);

  const total = selectedDates.reduce((sum, d) => sum + d.price, 0);

  const selectHome = useCallback((home: Home, locked = false) => {
    setSelectedHome(home);
    setHomeLocked(locked);
    setStep('dates');
  }, []);

  const submitGuestInfo = useCallback((info: GuestInfo) => {
    setGuestInfo(info);
    setStep('payment');
  }, []);

  const goToPayment = useCallback(() => {
    if (selectedDates.length > 0) setStep('guest');
  }, [selectedDates]);

  const toggleDate = useCallback((dateStr: string, temperature: number, price: number) => {
    setSelectedDates(prev => {
      const existing = prev.find(d => d.date === dateStr);
      if (existing) {
        if (existing.temperature === temperature) {
          return prev.filter(d => d.date !== dateStr);
        }
        return prev.map(d => d.date === dateStr ? { ...d, temperature, price } : d);
      }
      return [...prev, { date: dateStr, temperature, price }].sort((a, b) => a.date.localeCompare(b.date));
    });
  }, []);

  const removeDate = useCallback((dateStr: string) => {
    setSelectedDates(prev => prev.filter(d => d.date !== dateStr));
  }, []);

  const goBack = useCallback(() => {
    const steps: CheckoutStep[] = ['home', 'dates', 'guest', 'payment'];
    const idx = steps.indexOf(step);
    if (idx > 0) {
      if (step === 'dates' && homeLocked) return; // can't go back past locked home
      setStep(steps[idx - 1]);
    }
  }, [step, homeLocked]);

  return {
    step, setStep,
    selectedHome, selectHome, homeLocked,
    guestInfo, submitGuestInfo,
    selectedDates, toggleDate, removeDate,
    total,
    goToPayment,
    goBack,
    orderSummary, setOrderSummary,
  };
}
