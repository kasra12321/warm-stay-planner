import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Home, HeatingOption, Settings } from '@/lib/types';

export function useHomes() {
  return useQuery({
    queryKey: ['homes'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('homes')
        .select('*')
        .eq('active', true)
        .order('name');
      if (error) throw error;
      return data as Home[];
    },
  });
}

export function useHomeBySlug(slug: string | null) {
  return useQuery({
    queryKey: ['home', slug],
    queryFn: async () => {
      if (!slug) return null;
      const { data, error } = await supabase
        .from('homes')
        .select('*')
        .eq('slug', slug)
        .eq('active', true)
        .single();
      if (error) return null;
      return data as Home;
    },
    enabled: !!slug,
  });
}

export function useHeatingOptions() {
  return useQuery({
    queryKey: ['heating-options'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('heating_options')
        .select('*')
        .eq('active', true)
        .order('temperature');
      if (error) throw error;
      return data as HeatingOption[];
    },
  });
}

export function useBlockedDates(homeId: string | null) {
  return useQuery({
    queryKey: ['blocked-dates', homeId],
    queryFn: async () => {
      if (!homeId) return [];
      const { data, error } = await supabase.rpc('get_blocked_dates', {
        p_home_id: homeId,
      });
      if (error) throw error;
      return (data as { date: string }[]).map(d => d.date);
    },
    enabled: !!homeId,
    refetchInterval: 30000,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('settings')
        .select('*')
        .single();
      if (error) throw error;
      return data as Settings;
    },
  });
}
