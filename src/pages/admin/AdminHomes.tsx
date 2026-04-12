import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { Plus, Pencil, Home as HomeIcon } from 'lucide-react';

const AdminHomes = () => {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingHome, setEditingHome] = useState<any>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');

  const { data: homes, isLoading } = useQuery({
    queryKey: ['admin-homes'],
    queryFn: async () => {
      const { data, error } = await supabase.from('homes').select('*').order('name');
      if (error) throw error;
      return data;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (editingHome) {
        const { error } = await supabase.from('homes').update({ name, slug }).eq('id', editingHome.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('homes').insert({ name, slug });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-homes'] });
      setDialogOpen(false);
      setEditingHome(null);
      toast.success(editingHome ? 'Home updated' : 'Home added');
    },
    onError: (e: any) => toast.error(e.message),
  });

  const toggleActive = async (id: string, active: boolean) => {
    await supabase.from('homes').update({ active }).eq('id', id);
    queryClient.invalidateQueries({ queryKey: ['admin-homes'] });
  };

  const handlePhotoUpload = async (homeId: string, file: File) => {
    const ext = file.name.split('.').pop();
    const path = `${homeId}.${ext}`;
    const { error: uploadError } = await supabase.storage.from('home-photos').upload(path, file, { upsert: true });
    if (uploadError) { toast.error('Upload failed'); return; }
    const { data: { publicUrl } } = supabase.storage.from('home-photos').getPublicUrl(path);
    await supabase.from('homes').update({ cover_photo_url: publicUrl }).eq('id', homeId);
    queryClient.invalidateQueries({ queryKey: ['admin-homes'] });
    toast.success('Photo uploaded');
  };

  const openEdit = (home: any) => {
    setEditingHome(home);
    setName(home.name);
    setSlug(home.slug);
    setDialogOpen(true);
  };

  const openNew = () => {
    setEditingHome(null);
    setName('');
    setSlug('');
    setDialogOpen(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-foreground">Homes</h2>
        <Button onClick={openNew} size="sm"><Plus className="w-4 h-4 mr-1" /> Add Home</Button>
      </div>

      <div className="grid gap-3">
        {homes?.map(home => (
          <Card key={home.id}>
            <CardContent className="p-4 flex items-center gap-4">
              {home.cover_photo_url ? (
                <img src={home.cover_photo_url} alt={home.name} className="w-16 h-16 rounded-lg object-cover" />
              ) : (
                <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center">
                  <HomeIcon className="w-6 h-6 text-muted-foreground" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground">{home.name}</span>
                  <Badge variant={home.active ? 'default' : 'secondary'}>{home.active ? 'Active' : 'Inactive'}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">/{home.slug}</p>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={home.active} onCheckedChange={v => toggleActive(home.id, v)} />
                <Button variant="ghost" size="icon" onClick={() => openEdit(home)}>
                  <Pencil className="w-4 h-4" />
                </Button>
                <label className="cursor-pointer">
                  <input type="file" accept="image/*" className="hidden" onChange={e => e.target.files?.[0] && handlePhotoUpload(home.id, e.target.files[0])} />
                  <span className="text-xs text-primary hover:underline">Photo</span>
                </label>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingHome ? 'Edit Home' : 'Add Home'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Beach House" />
            </div>
            <div className="space-y-2">
              <Label>Slug</Label>
              <Input value={slug} onChange={e => setSlug(e.target.value)} placeholder="beach-house" />
              <p className="text-xs text-muted-foreground">Used in URL: ?home={slug || 'your-slug'}</p>
            </div>
            <Button onClick={() => saveMutation.mutate()} disabled={!name || !slug} className="w-full">
              {editingHome ? 'Update' : 'Create'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminHomes;
