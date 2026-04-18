export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      heating_options: {
        Row: {
          active: boolean
          created_at: string
          id: string
          price_per_day: number
          temperature: number
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          price_per_day: number
          temperature: number
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          price_per_day?: number
          temperature?: number
        }
        Relationships: []
      }
      home_pool_state: {
        Row: {
          created_at: string
          current_mode: string
          current_target_temp: number | null
          home_id: string
          id: string
          last_occupancy_check: string | null
          last_synced_at: string | null
          next_checkin_date: string | null
          notes: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_mode?: string
          current_target_temp?: number | null
          home_id: string
          id?: string
          last_occupancy_check?: string | null
          last_synced_at?: string | null
          next_checkin_date?: string | null
          notes?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_mode?: string
          current_target_temp?: number | null
          home_id?: string
          id?: string
          last_occupancy_check?: string | null
          last_synced_at?: string | null
          next_checkin_date?: string | null
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "home_pool_state_home_id_fkey"
            columns: ["home_id"]
            isOneToOne: true
            referencedRelation: "homes"
            referencedColumns: ["id"]
          },
        ]
      }
      homes: {
        Row: {
          active: boolean
          cover_photo_url: string | null
          created_at: string
          eco_mode_enabled: boolean
          eco_temp: number
          hospitable_property_id: string | null
          iaqualink_baseline_temp: number
          iaqualink_enabled: boolean
          iaqualink_serial: string | null
          id: string
          internal_name: string | null
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          cover_photo_url?: string | null
          created_at?: string
          eco_mode_enabled?: boolean
          eco_temp?: number
          hospitable_property_id?: string | null
          iaqualink_baseline_temp?: number
          iaqualink_enabled?: boolean
          iaqualink_serial?: string | null
          id?: string
          internal_name?: string | null
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          cover_photo_url?: string | null
          created_at?: string
          eco_mode_enabled?: boolean
          eco_temp?: number
          hospitable_property_id?: string | null
          iaqualink_baseline_temp?: number
          iaqualink_enabled?: boolean
          iaqualink_serial?: string | null
          id?: string
          internal_name?: string | null
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      iaqualink_credentials: {
        Row: {
          auth_token: string | null
          email: string | null
          id: string
          last_login_at: string | null
          session_id: string | null
          updated_at: string
          user_id_external: string | null
        }
        Insert: {
          auth_token?: string | null
          email?: string | null
          id?: string
          last_login_at?: string | null
          session_id?: string | null
          updated_at?: string
          user_id_external?: string | null
        }
        Update: {
          auth_token?: string | null
          email?: string | null
          id?: string
          last_login_at?: string | null
          session_id?: string | null
          updated_at?: string
          user_id_external?: string | null
        }
        Relationships: []
      }
      order_dates: {
        Row: {
          date: string
          id: string
          order_id: string
          price: number
          temperature: number
        }
        Insert: {
          date: string
          id?: string
          order_id: string
          price: number
          temperature: number
        }
        Update: {
          date?: string
          id?: string
          order_id?: string
          price?: number
          temperature?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_dates_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          created_at: string
          guest_mobile: string
          guest_name: string
          home_id: string
          id: string
          payment_method: Database["public"]["Enums"]["payment_method"]
          status: Database["public"]["Enums"]["order_status"]
          stripe_session_id: string | null
          total: number
        }
        Insert: {
          created_at?: string
          guest_mobile: string
          guest_name: string
          home_id: string
          id?: string
          payment_method: Database["public"]["Enums"]["payment_method"]
          status: Database["public"]["Enums"]["order_status"]
          stripe_session_id?: string | null
          total: number
        }
        Update: {
          created_at?: string
          guest_mobile?: string
          guest_name?: string
          home_id?: string
          id?: string
          payment_method?: Database["public"]["Enums"]["payment_method"]
          status?: Database["public"]["Enums"]["order_status"]
          stripe_session_id?: string | null
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "orders_home_id_fkey"
            columns: ["home_id"]
            isOneToOne: false
            referencedRelation: "homes"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      reminders: {
        Row: {
          action_type: Database["public"]["Enums"]["reminder_action"]
          auto_executed: boolean
          auto_execution_result: string | null
          created_at: string
          home_id: string
          id: string
          message: string
          order_id: string
          scheduled_at: string
          sent: boolean
          sent_at: string | null
          target_temperature: number | null
        }
        Insert: {
          action_type: Database["public"]["Enums"]["reminder_action"]
          auto_executed?: boolean
          auto_execution_result?: string | null
          created_at?: string
          home_id: string
          id?: string
          message: string
          order_id: string
          scheduled_at: string
          sent?: boolean
          sent_at?: string | null
          target_temperature?: number | null
        }
        Update: {
          action_type?: Database["public"]["Enums"]["reminder_action"]
          auto_executed?: boolean
          auto_execution_result?: string | null
          created_at?: string
          home_id?: string
          id?: string
          message?: string
          order_id?: string
          scheduled_at?: string
          sent?: boolean
          sent_at?: string | null
          target_temperature?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "reminders_home_id_fkey"
            columns: ["home_id"]
            isOneToOne: false
            referencedRelation: "homes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reminders_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      settings: {
        Row: {
          admin_calendar_email: string | null
          admin_email: string | null
          admin_sms_number: string | null
          created_at: string
          id: string
          twilio_from_number: string | null
          updated_at: string
          venmo_handle: string | null
          venmo_instructions: string | null
          zelle_instructions: string | null
        }
        Insert: {
          admin_calendar_email?: string | null
          admin_email?: string | null
          admin_sms_number?: string | null
          created_at?: string
          id?: string
          twilio_from_number?: string | null
          updated_at?: string
          venmo_handle?: string | null
          venmo_instructions?: string | null
          zelle_instructions?: string | null
        }
        Update: {
          admin_calendar_email?: string | null
          admin_email?: string | null
          admin_sms_number?: string | null
          created_at?: string
          id?: string
          twilio_from_number?: string | null
          updated_at?: string
          venmo_handle?: string | null
          venmo_instructions?: string | null
          zelle_instructions?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_blocked_dates: {
        Args: { p_home_id: string }
        Returns: {
          date: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin"
      order_status:
        | "venmo_submitted"
        | "zelle_submitted"
        | "stripe_pending"
        | "stripe_paid"
        | "stripe_failed"
      payment_method: "venmo" | "zelle" | "stripe"
      reminder_action: "turn_on" | "change" | "turn_off"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin"],
      order_status: [
        "venmo_submitted",
        "zelle_submitted",
        "stripe_pending",
        "stripe_paid",
        "stripe_failed",
      ],
      payment_method: ["venmo", "zelle", "stripe"],
      reminder_action: ["turn_on", "change", "turn_off"],
    },
  },
} as const
