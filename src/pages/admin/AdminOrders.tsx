import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Trash2, Pencil, Plus, X } from 'lucide-react';
import { toast } from 'sonner';

type OrderDate = { id: string; date: string; temperature: number; price: number };

const AdminOrders = () => {
  const queryClient = useQueryClient();
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

  const { data: heatingOptions } = useQuery({
    queryKey: ['active-heating-options'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('heating_options')
        .select('*')
        .eq('active', true)
        .order('temperature');
      if (error) throw error;
      return data;
    },
  });

  const [editingOrder, setEditingOrder] = useState<any | null>(null);
  const [editDates, setEditDates] = useState<OrderDate[]>([]);
  const [newDate, setNewDate] = useState('');
  const [newTemp, setNewTemp] = useState<number | ''>('');

  const openEdit = (order: any) => {
    setEditingOrder(order);
    const dates = (order.order_dates as OrderDate[])
      .map((d) => ({ ...d, price: Number(d.price) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    setEditDates(dates);
    setNewDate('');
    setNewTemp('');
  };

  const closeEdit = () => {
    setEditingOrder(null);
    setEditDates([]);
  };

  const priceFor = (temp: number) =>
    Number(heatingOptions?.find((o) => o.temperature === temp)?.price_per_day ?? 0);

  const updateRowTemp = (idx: number, temp: number) => {
    setEditDates((prev) => prev.map((d, i) => i === idx ? { ...d, temperature: temp, price: priceFor(temp) } : d));
  };

  const removeRow = (idx: number) => {
    setEditDates((prev) => prev.filter((_, i) => i !== idx));
  };

  const addRow = () => {
    if (!newDate || !newTemp) {
      toast.error('Pick a date and temperature');
      return;
    }
    if (editDates.some((d) => d.date === newDate)) {
      toast.error('Date already in order');
      return;
    }
    const t = Number(newTemp);
    setEditDates((prev) => [
      ...prev,
      { id: `new-${Date.now()}`, date: newDate, temperature: t, price: priceFor(t) },
    ].sort((a, b) => a.date.localeCompare(b.date)));
    setNewDate('');
    setNewTemp('');
  };

  const editTotal = editDates.reduce((s, d) => s + Number(d.price), 0);

  const saveEditMutation = useMutation({
    mutationFn: async () => {
      if (!editingOrder) return;
      if (editDates.length === 0) throw new Error('Order must have at least one date');
      const orderId = editingOrder.id;

      // Replace order_dates: delete all, insert fresh.
      const { error: delErr } = await supabase.from('order_dates').delete().eq('order_id', orderId);
      if (delErr) throw delErr;

      const { error: insErr } = await supabase.from('order_dates').insert(
        editDates.map((d) => ({
          order_id: orderId,
          date: d.date,
          temperature: d.temperature,
          price: d.price,
        }))
      );
      if (insErr) throw insErr;

      // Update total + clear reminders_created_at so we can regenerate.
      const { error: updErr } = await supabase
        .from('orders')
        .update({ total: editTotal, reminders_created_at: null })
        .eq('id', orderId);
      if (updErr) throw updErr;

      // Wipe pending reminders, regenerate.
      await supabase.from('reminders').delete().eq('order_id', orderId).eq('sent', false);
      await supabase.functions.invoke('create-reminders', { body: { orderId } });
    },
    onSuccess: () => {
      toast.success('Order updated');
      queryClient.invalidateQueries({ queryKey: ['admin-all-orders'] });
      queryClient.invalidateQueries({ queryKey: ['admin-schedule'] });
      closeEdit();
    },
    onError: (e: any) => toast.error(e.message || 'Failed to update'),
  });

  const cancelOrderMutation = useMutation({
    mutationFn: async (orderId: string) => {
      // Remove pending reminders so the pool isn't toggled.
      await supabase.from('reminders').delete().eq('order_id', orderId).eq('sent', false);
      await supabase.from('order_dates').delete().eq('order_id', orderId);
      const { error } = await supabase.from('orders').delete().eq('id', orderId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Order canceled');
      queryClient.invalidateQueries({ queryKey: ['admin-all-orders'] });
      queryClient.invalidateQueries({ queryKey: ['admin-schedule'] });
    },
    onError: (e: any) => toast.error(e.message || 'Failed to cancel'),
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
                  <Badge
                    variant={
                      order.status === 'stripe_paid' ? 'default'
                      : order.status === 'awaiting_confirmation' ? 'outline'
                      : order.status === 'stripe_failed' ? 'destructive'
                      : 'secondary'
                    }
                    className="capitalize"
                  >
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
                <div className="flex items-center justify-between pt-1">
                  <p className="text-xs text-muted-foreground">
                    {new Date(order.created_at).toLocaleString()} · ID: {order.id.slice(0, 8)}
                  </p>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(order)}>
                      <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive">
                          <Trash2 className="w-3.5 h-3.5 mr-1" /> Cancel
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This permanently removes the order and any pending heat actions for it. This cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Keep order</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => cancelOrderMutation.mutate(order.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Cancel order
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!editingOrder} onOpenChange={(o) => { if (!o) closeEdit(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Order</DialogTitle>
            <DialogDescription>
              Change dates or temperatures. Pending heat actions will be regenerated.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 max-h-72 overflow-y-auto">
            {editDates.map((d, idx) => (
              <div key={d.id} className="flex items-center gap-2 p-2 rounded border border-border">
                <span className="text-sm flex-1">
                  {new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                </span>
                <select
                  value={d.temperature}
                  onChange={(e) => updateRowTemp(idx, Number(e.target.value))}
                  className="h-8 text-sm rounded border border-input bg-background px-2"
                >
                  {heatingOptions?.map((o) => (
                    <option key={o.id} value={o.temperature}>{o.temperature}°F</option>
                  ))}
                </select>
                <span className="text-sm w-14 text-right">${Number(d.price).toFixed(0)}</span>
                <Button size="sm" variant="ghost" onClick={() => removeRow(idx)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>

          <div className="space-y-2 border-t pt-3">
            <Label className="text-xs">Add another date</Label>
            <div className="flex gap-2">
              <Input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className="h-9 text-sm" />
              <select
                value={newTemp}
                onChange={(e) => setNewTemp(e.target.value ? Number(e.target.value) : '')}
                className="h-9 text-sm rounded border border-input bg-background px-2"
              >
                <option value="">Temp</option>
                {heatingOptions?.map((o) => (
                  <option key={o.id} value={o.temperature}>{o.temperature}°F</option>
                ))}
              </select>
              <Button size="sm" variant="outline" onClick={addRow}>
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          </div>

          <div className="flex justify-between items-center border-t pt-3">
            <span className="text-sm text-muted-foreground">New total</span>
            <span className="font-semibold">${editTotal.toFixed(2)}</span>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={closeEdit}>Cancel</Button>
            <Button onClick={() => saveEditMutation.mutate()} disabled={saveEditMutation.isPending}>
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminOrders;
