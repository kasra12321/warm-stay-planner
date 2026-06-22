import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, AlertTriangle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useBlockedDates, usePricingBands, useFallbackOptions, useDailyForecast, useSettings } from '@/hooks/useData';
import type { SelectedDate } from '@/lib/types';
import { getOptionsForDate, addDaysPacific } from '@/lib/pricing';
import { isSameDayWarning, isSameDayCutoff, formatDateDisplay, getTodayPacific } from '@/lib/pacific-time';
import { ArrowLeft } from 'lucide-react';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';

interface Props {
  homeId: string;
  homeName: string;
  selectedDates: SelectedDate[];
  onToggleDate: (date: string, temperature: number, price: number) => void;
  onRemoveDate: (date: string) => void;
  onContinue: () => void;
  onBack: () => void;
  total: number;
}

export function DateSelection({
  homeId, homeName, selectedDates, onToggleDate, onRemoveDate, onContinue, onBack, total,
}: Props) {
  const { data: blockedDates } = useBlockedDates(homeId);
  const { data: bands } = usePricingBands();
  const { data: fallback } = useFallbackOptions();
  const { data: forecast } = useDailyForecast();
  const { data: settings } = useSettings();
  const windowDays = settings?.booking_window_days || 14;

  const todayStr = getTodayPacific();
  const lastBookableStr = addDaysPacific(todayStr, windowDays - 1);

  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [drawerDate, setDrawerDate] = useState<string | null>(null);
  const [sameDayWarningShown, setSameDayWarningShown] = useState(false);

  const blockedSet = useMemo(() => new Set(blockedDates || []), [blockedDates]);
  const selectedMap = useMemo(() => {
    const map = new Map<string, SelectedDate>();
    selectedDates.forEach(d => map.set(d.date, d));
    return map;
  }, [selectedDates]);

  const daysInMonth = new Date(currentMonth.year, currentMonth.month + 1, 0).getDate();
  const firstDayOfWeek = new Date(currentMonth.year, currentMonth.month, 1).getDay();

  const monthLabel = new Date(currentMonth.year, currentMonth.month).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  const todayYear = Number(todayStr.slice(0, 4));
  const todayMonthIdx = Number(todayStr.slice(5, 7)) - 1;
  const lastYear = Number(lastBookableStr.slice(0, 4));
  const lastMonthIdx = Number(lastBookableStr.slice(5, 7)) - 1;
  const canPrev = currentMonth.year > todayYear || (currentMonth.year === todayYear && currentMonth.month > todayMonthIdx);
  const canNext = currentMonth.year < lastYear || (currentMonth.year === lastYear && currentMonth.month < lastMonthIdx);

  const prevMonth = () => {
    if (!canPrev) return;
    setCurrentMonth(p => p.month === 0 ? { year: p.year - 1, month: 11 } : { ...p, month: p.month - 1 });
  };
  const nextMonth = () => {
    if (!canNext) return;
    setCurrentMonth(p => p.month === 11 ? { year: p.year + 1, month: 0 } : { ...p, month: p.month + 1 });
  };

  const dayPricing = (dateStr: string) => getOptionsForDate(dateStr, forecast, bands, fallback);

  const handleDayClick = (dateStr: string) => {
    if (blockedSet.has(dateStr)) return;
    if (dateStr < todayStr) return;
    if (dateStr > lastBookableStr) return;
    if (isSameDayCutoff(dateStr)) return;
    if (dayPricing(dateStr).options.length === 0) return;

    const existing = selectedMap.get(dateStr);
    if (existing) {
      setDrawerDate(dateStr);
    } else {
      if (isSameDayWarning(dateStr) && !sameDayWarningShown) {
        setSameDayWarningShown(true);
      }
      setDrawerDate(dateStr);
    }
  };

  const handleSelectTemp = (opt: { temperature: number; price: number }) => {
    if (drawerDate) {
      onToggleDate(drawerDate, opt.temperature, opt.price);
      setDrawerDate(null);
    }
  };

  const handleRemoveFromDrawer = () => {
    if (drawerDate) {
      onRemoveDate(drawerDate);
      setDrawerDate(null);
    }
  };

  const drawerPricing = drawerDate ? dayPricing(drawerDate) : null;

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="text-center space-y-1">
        <h2 className="text-2xl font-bold text-foreground">Select Dates</h2>
        <p className="text-muted-foreground">Pick the day(s) you want the pool heated at <span className="font-medium text-foreground">{homeName}</span></p>
      </div>

      <div className="bg-muted/50 border border-border rounded-lg p-3 text-xs text-muted-foreground leading-relaxed">
        Our goal is for you to just cover the gas cost of heating the pool. Prices change with the forecast high temperature each day so you pay close to what it actually costs to warm the water. Bookings are open for the next {windowDays} days.
      </div>

      {sameDayWarningShown && (
        <div className="flex items-start gap-2 bg-warning/10 border border-warning/30 rounded-lg p-3">
          <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
          <p className="text-sm text-warning-foreground">
            Heads up: you're booking same-day heating after 12 PM. We'll do our best, but the pool may not reach your selected temperature by the end of the day. Same-day bookings close at 3 PM.
          </p>
        </div>
      )}

      <div className="bg-card rounded-xl border p-4">
        <div className="flex items-center justify-between mb-4">
          <button onClick={prevMonth} disabled={!canPrev} className="p-2 hover:bg-muted rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <span className="font-semibold text-foreground">{monthLabel}</span>
          <button onClick={nextMonth} disabled={!canNext} className="p-2 hover:bg-muted rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center mb-2">
          {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(d => (
            <div key={d} className="text-xs font-medium text-muted-foreground py-1">{d}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: firstDayOfWeek }).map((_, i) => (
            <div key={`empty-${i}`} />
          ))}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const dateStr = `${currentMonth.year}-${String(currentMonth.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const isPast = dateStr < todayStr;
            const isAfterWindow = dateStr > lastBookableStr;
            const isBlocked = blockedSet.has(dateStr);
            const isCutoff = isSameDayCutoff(dateStr);
            const selected = selectedMap.get(dateStr);
            const pricing = !isPast && !isAfterWindow ? dayPricing(dateStr) : null;
            const noPricing = pricing !== null && pricing.options.length === 0;
            const isDisabled = isPast || isAfterWindow || isBlocked || isCutoff || noPricing;

            return (
              <button
                key={day}
                onClick={() => !isDisabled && handleDayClick(dateStr)}
                disabled={isDisabled}
                className={`
                  relative aspect-square flex flex-col items-center justify-center rounded-lg text-sm transition-all
                  ${isDisabled ? 'text-muted-foreground/40 cursor-not-allowed' : 'hover:bg-muted cursor-pointer active:scale-95'}
                  ${selected ? 'bg-primary text-primary-foreground hover:bg-primary/90 font-semibold' : ''}
                  ${isBlocked ? 'line-through' : ''}
                `}
              >
                <span>{day}</span>
                {selected ? (
                  <span className="text-[10px] leading-none font-normal">{selected.temperature}°</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {selectedDates.length > 0 && (
        <div className="bg-card rounded-xl border p-4 space-y-3">
          <h3 className="font-semibold text-foreground">Order Summary</h3>
          <p className="text-xs text-muted-foreground">Each date below is a day the pool will be heated.</p>
          <div className="space-y-2">
            {selectedDates.map(d => (
              <div key={d.date} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span>{formatDateDisplay(d.date)}</span>
                  <Badge variant="secondary" className="text-xs">{d.temperature}°F</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">${d.price}</span>
                  <button onClick={() => onRemoveDate(d.date)} className="p-1 hover:bg-muted rounded">
                    <X className="w-3 h-3 text-muted-foreground" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t pt-2 flex justify-between font-semibold text-foreground">
            <span>Total</span>
            <span>${total.toFixed(2)}</span>
          </div>
          <Button onClick={onContinue} className="w-full h-12 text-base font-semibold">
            Continue
          </Button>
        </div>
      )}

      <Drawer open={!!drawerDate} onOpenChange={open => !open && setDrawerDate(null)}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>
              {drawerDate ? formatDateDisplay(drawerDate) : 'Select Temperature'}
            </DrawerTitle>
          </DrawerHeader>
          <div className="p-4 pb-8 space-y-3">
            {drawerPricing && drawerPricing.high !== null && (
              <p className="text-xs text-muted-foreground">
                Forecast high: <span className="font-medium text-foreground">{drawerPricing.high}°F</span>
                {drawerPricing.source === 'fallback' && ' · standard pricing'}
              </p>
            )}
            {drawerDate && isSameDayWarning(drawerDate) && (
              <div className="flex items-start gap-2 bg-warning/10 border border-warning/30 rounded-lg p-3 mb-2">
                <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                <p className="text-xs text-warning-foreground">
                  You're booking same-day heating after 12 PM. We'll do our best, but the pool may not reach your selected temperature by the end of the day. Same-day bookings close at 3 PM.
                </p>
              </div>
            )}
            {drawerPricing?.options.map(opt => {
              const isSelected = drawerDate && selectedMap.get(drawerDate)?.temperature === opt.temperature;
              return (
                <button
                  key={opt.temperature}
                  onClick={() => handleSelectTemp(opt)}
                  className={`w-full p-4 rounded-xl border-2 text-left transition-all active:scale-[0.98] ${
                    isSelected
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/50'
                  }`}
                >
                  <div className="flex justify-between items-center">
                    <div>
                      <span className="text-xl font-bold text-foreground">{opt.temperature}°F</span>
                    </div>
                    <span className="text-lg font-semibold text-foreground">${opt.price}/day</span>
                  </div>
                </button>
              );
            })}
            {drawerDate && selectedMap.has(drawerDate) && (
              <Button variant="outline" onClick={handleRemoveFromDrawer} className="w-full h-12">
                Remove this date
              </Button>
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}