import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Home as HomeIcon, Upload, Loader2 } from 'lucide-react';

const AdminHomes = () => {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingHome, setEditingHome] = useState<any>(null);
  const [name, setName] = useState('');
  const [internalName, setInternalName] = useState('');
  const [slug, setSlug] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      let homeId = editingHome?.id;

      if (editingHome) {
        const { error } = await supabase.from('homes').update({ name, slug, internal_name: internalName || name }).eq('id', homeId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from('homes').insert({ name, slug, internal_name: internalName || name }).select().single();
        if (error) throw error;
        homeId = data.id;
      }

      if (photoFile && homeId) {
        const ext = photoFile.name.split('.').pop();
        const path = `${homeId}.${ext}`;
        const { error: uploadError } = await supabase.storage.from('home-photos').upload(path, photoFile, { upsert: true });
        if (uploadError) throw uploadError;
        const { data: { publicUrl } } = supabase.storage.from('home-photos').getPublicUrl(path);
        await supabase.from('homes').update({ cover_photo_url: publicUrl }).eq('id', homeId);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-homes'] });
      setDialogOpen(false);
      setEditingHome(null);
      setPhotoFile(null);
      setPhotoPreview(null);
      toast.success(editingHome ? 'Home updated' : 'Home added');
    },
    onError: (e: any) => toast.error(e.message),
  });

  const [deleteTarget, setDeleteTarget] = useState<any>(null);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('homes').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-homes'] });
      toast.success('Property deleted');
      setDeleteTarget(null);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const toggleActive = async (id: string, active: boolean) => {
    await supabase.from('homes').update({ active }).eq('id', id);
    queryClient.invalidateQueries({ queryKey: ['admin-homes'] });
  };

  const openEdit = (home: any) => {
    setEditingHome(home);
    setName(home.name);
    setInternalName(home.internal_name || '');
    setSlug(home.slug);
    setPhotoFile(null);
    setPhotoPreview(home.cover_photo_url || null);
    setDialogOpen(true);
  };

  const openNew = () => {
    setEditingHome(null);
    setName('');
    setInternalName('');
    setSlug('');
    setPhotoFile(null);
    setPhotoPreview(null);
    setDialogOpen(true);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setPhotoFile(file);
      setPhotoPreview(URL.createObjectURL(file));
    }
  };

  // Auto-generate slug from display name
  const handleNameChange = (value: string) => {
    setName(value);
    if (!editingHome) {
      setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-foreground">Properties</h2>
        <Button onClick={openNew} size="sm"><Plus className="w-4 h-4 mr-1" /> Add Property</Button>
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
                {home.internal_name && home.internal_name !== home.name && (
                  <p className="text-sm text-muted-foreground">Internal: {home.internal_name}</p>
                )}
                <p className="text-xs text-muted-foreground">/{home.slug}</p>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={home.active} onCheckedChange={v => toggleActive(home.id, v)} />
                <Button variant="ghost" size="icon" onClick={() => openEdit(home)}>
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(home)} className="text-destructive hover:text-destructive">
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingHome ? 'Edit Property' : 'Add Property'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Photo upload */}
            <div className="space-y-2">
              <Label>Cover Photo</Label>
              <div
                className="border-2 border-dashed rounded-lg p-4 flex flex-col items-center gap-2 cursor-pointer hover:border-primary transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                {photoPreview ? (
                  <img src={photoPreview} alt="Preview" className="w-full h-32 object-cover rounded-md" />
                ) : (
                  <>
                    <Upload className="w-8 h-8 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Click to upload photo</span>
                  </>
                )}
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Display Name <span className="text-xs text-muted-foreground">(shown to guests)</span></Label>
              <Input value={name} onChange={e => handleNameChange(e.target.value)} placeholder="The Beach House" />
            </div>

            <div className="space-y-2">
              <Label>Internal Name <span className="text-xs text-muted-foreground">(used in your notifications)</span></Label>
              <Input value={internalName} onChange={e => setInternalName(e.target.value)} placeholder={name || 'e.g. 123 Ocean Dr'} />
              {!internalName && <p className="text-xs text-muted-foreground">If blank, display name will be used</p>}
            </div>

            <div className="space-y-2">
              <Label>Slug</Label>
              <Input value={slug} onChange={e => setSlug(e.target.value)} placeholder="beach-house" />
              <p className="text-xs text-muted-foreground">Used in URL: ?home={slug || 'your-slug'}</p>
            </div>

            <Button onClick={() => saveMutation.mutate()} disabled={!name || !slug || saveMutation.isPending} className="w-full">
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
              {editingHome ? 'Update' : 'Create'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove this property. Any existing orders linked to it may be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteMutation.mutate(deleteTarget.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default AdminHomes;
