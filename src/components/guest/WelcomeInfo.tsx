import { Thermometer, Clock, CalendarCheck } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

export function WelcomeInfo() {
  return (
    <div className="space-y-4 mb-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-bold text-foreground">Pool Heat Upgrade</h2>
        <p className="text-muted-foreground text-sm leading-relaxed max-w-md mx-auto">
          Our pool is automatically heated to about <span className="font-semibold text-foreground">81°F</span> at no additional cost. 
          Some guests prefer it a little warmer — with this upgrade, we'll heat the pool to either <span className="font-semibold text-foreground">85°F ($75/day)</span> or <span className="font-semibold text-foreground">90°F ($100/day)</span> based on your selection.
        </p>
        <p className="text-muted-foreground text-xs leading-relaxed max-w-md mx-auto">
          Because reaching higher temperatures requires a significant amount of natural gas, this option helps cover the additional heating cost.
        </p>
      </div>

      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" />
            Important Notes
          </h3>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <CalendarCheck className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
              <span>Please purchase before <span className="font-medium text-foreground">11 AM</span> on the day you'd like the pool heated.</span>
            </li>
            <li className="flex items-start gap-2">
              <Thermometer className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
              <span>The pool typically takes <span className="font-medium text-foreground">2–4 hours</span> to reach the desired temperature, depending on the weather.</span>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
