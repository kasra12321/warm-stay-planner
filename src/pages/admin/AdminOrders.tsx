import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const AdminOrders = () => {
  const { data: orders, isLoading } = useQuery({
    queryKey: ['admin-all-orders'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*, homes(name), order_dates(*)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-foreground">Orders</h2>

      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : !orders?.length ? (
        <p className="text-muted-foreground">No orders yet</p>
      ) : (
        <div className="space-y-3">
          {orders.map(order => (
            <Card key={order.id}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-semibold text-foreground">{order.guest_name}</span>
                    <span className="text-muted-foreground text-sm ml-2">{order.guest_mobile}</span>
                  </div>
                  <Badge variant={order.status === 'stripe_paid' ? 'default' : 'secondary'} className="capitalize">
                    {order.status.replace(/_/g, ' ')}
                  </Badge>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>{(order.homes as any)?.name}</span>
                  <span>·</span>
                  <span className="capitalize">{order.payment_method}</span>
                  <span>·</span>
                  <span>${order.total}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {(order.order_dates as any[])?.sort((a: any, b: any) => a.date.localeCompare(b.date)).map((d: any) => (
                    <Badge key={d.id} variant="outline" className="text-xs">
                      {new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {d.temperature}°F · ${d.price}
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(order.created_at).toLocaleString()} · ID: {order.id.slice(0, 8)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default AdminOrders;
