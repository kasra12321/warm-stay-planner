import { useHomes } from '@/hooks/useData';
import type { Home } from '@/lib/types';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Home as HomeIcon } from 'lucide-react';

interface Props {
  onSelect: (home: Home) => void;
}

export function HomeSelection({ onSelect }: Props) {
  const { data: homes, isLoading } = useHomes();

  return (
    <div className="space-y-4">
      <div className="text-center space-y-1">
        <h2 className="text-2xl font-bold text-foreground">Select Your Rental</h2>
        <p className="text-muted-foreground">Choose the property to add pool heating</p>
      </div>

      {isLoading ? (
        <div className="grid gap-3">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-28 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3">
          {homes?.map(home => (
            <Card
              key={home.id}
              className="cursor-pointer hover:shadow-md transition-shadow active:scale-[0.98] overflow-hidden"
              onClick={() => onSelect(home)}
            >
              <CardContent className="p-0">
                <div className="flex items-center gap-4">
                  {home.cover_photo_url ? (
                    <img
                      src={home.cover_photo_url}
                      alt={home.name}
                      className="w-24 h-24 object-cover flex-shrink-0"
                    />
                  ) : (
                    <div className="w-24 h-24 bg-muted flex items-center justify-center flex-shrink-0">
                      <HomeIcon className="w-8 h-8 text-muted-foreground" />
                    </div>
                  )}
                  <div className="py-3 pr-4">
                    <h3 className="font-semibold text-foreground text-lg">{home.name}</h3>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          {homes?.length === 0 && (
            <p className="text-center text-muted-foreground py-8">No properties available at this time.</p>
          )}
        </div>
      )}
    </div>
  );
}
