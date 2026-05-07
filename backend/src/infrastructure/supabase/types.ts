export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      cargas: {
        Row: {
          bonus: number | null
          bonus_exigencias: string | null
          booked_at: string | null
          booked_driver_id: string | null
          cliente_id: string | null
          created_at: string
          created_by: string | null
          data: string
          distancia_km: number | null
          destino: string
          driver_visibility: string
          duracao_horas: number | null
          horario: string
          id: string
          is_template: boolean
          origem: string
          perfil: string
          published_at: string | null
          reserved_at: string | null
          reserved_claim_id: string | null
          reserved_driver_id: string | null
          reserved_public_lead_id: string | null
          reserved_until: string | null
          sheet_data_carregamento: string | null
          sheet_data_descarga: string | null
          sheet_lh: string | null
          sheet_synced_at: string | null
          sheet_tipo: string | null
          status: string
          updated_at: string
          valor: number | null
          version: number
        }
        Insert: {
          bonus?: number | null
          bonus_exigencias?: string | null
          booked_at?: string | null
          booked_driver_id?: string | null
          cliente_id?: string | null
          created_at?: string
          created_by?: string | null
          data: string
          distancia_km?: number | null
          destino: string
          driver_visibility?: string
          duracao_horas?: number | null
          horario: string
          id?: string
          is_template?: boolean
          origem: string
          perfil?: string
          published_at?: string | null
          reserved_at?: string | null
          reserved_claim_id?: string | null
          reserved_driver_id?: string | null
          reserved_public_lead_id?: string | null
          reserved_until?: string | null
          sheet_data_carregamento?: string | null
          sheet_data_descarga?: string | null
          sheet_lh?: string | null
          sheet_synced_at?: string | null
          sheet_tipo?: string | null
          status?: string
          updated_at?: string
          valor?: number | null
          version?: number
        }
        Update: {
          bonus?: number | null
          bonus_exigencias?: string | null
          booked_at?: string | null
          booked_driver_id?: string | null
          cliente_id?: string | null
          created_at?: string
          created_by?: string | null
          data?: string
          distancia_km?: number | null
          destino?: string
          driver_visibility?: string
          duracao_horas?: number | null
          horario?: string
          id?: string
          is_template?: boolean
          origem?: string
          perfil?: string
          published_at?: string | null
          reserved_at?: string | null
          reserved_claim_id?: string | null
          reserved_driver_id?: string | null
          reserved_public_lead_id?: string | null
          reserved_until?: string | null
          sheet_data_carregamento?: string | null
          sheet_data_descarga?: string | null
          sheet_lh?: string | null
          sheet_synced_at?: string | null
          sheet_tipo?: string | null
          status?: string
          updated_at?: string
          valor?: number | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "cargas_cliente_id_fkey"
            columns: ["cliente_id"]
            isOneToOne: false
            referencedRelation: "clientes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cargas_reserved_claim_id_fkey"
            columns: ["reserved_claim_id"]
            isOneToOne: false
            referencedRelation: "load_claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cargas_reserved_public_lead_id_fkey"
            columns: ["reserved_public_lead_id"]
            isOneToOne: false
            referencedRelation: "load_public_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      clientes: {
        Row: {
          antt: string | null
          created_at: string
          descricao: string | null
          exige_antt: boolean
          exige_carga_monitorada: boolean
          exige_rastreamento: boolean
          exige_seguro: boolean
          forma_pagamento: string | null
          id: string
          logo_url: string | null
          logo_url_card: string | null
          logo_url_proximas: string | null
          nome: string
          observacoes: string | null
          peso: string | null
          prazo_pagamento: string | null
          rastreamento: string | null
          reputacao_boa_comunicacao: boolean
          reputacao_bom_pagador: boolean
          reputacao_carga_organizada: boolean
          reputacao_liberacao_rapida: boolean
          reputacao_pagamento_rapido: boolean
          tipo_veiculo: string | null
          valor_frete: string | null
        }
        Insert: {
          antt?: string | null
          created_at?: string
          descricao?: string | null
          exige_antt?: boolean
          exige_carga_monitorada?: boolean
          exige_rastreamento?: boolean
          exige_seguro?: boolean
          forma_pagamento?: string | null
          id?: string
          logo_url?: string | null
          logo_url_card?: string | null
          logo_url_proximas?: string | null
          nome: string
          observacoes?: string | null
          peso?: string | null
          prazo_pagamento?: string | null
          rastreamento?: string | null
          reputacao_boa_comunicacao?: boolean
          reputacao_bom_pagador?: boolean
          reputacao_carga_organizada?: boolean
          reputacao_liberacao_rapida?: boolean
          reputacao_pagamento_rapido?: boolean
          tipo_veiculo?: string | null
          valor_frete?: string | null
        }
        Update: {
          antt?: string | null
          created_at?: string
          descricao?: string | null
          exige_antt?: boolean
          exige_carga_monitorada?: boolean
          exige_rastreamento?: boolean
          exige_seguro?: boolean
          forma_pagamento?: string | null
          id?: string
          logo_url?: string | null
          logo_url_card?: string | null
          logo_url_proximas?: string | null
          nome?: string
          observacoes?: string | null
          peso?: string | null
          prazo_pagamento?: string | null
          rastreamento?: string | null
          reputacao_boa_comunicacao?: boolean
          reputacao_bom_pagador?: boolean
          reputacao_carga_organizada?: boolean
          reputacao_liberacao_rapida?: boolean
          reputacao_pagamento_rapido?: boolean
          tipo_veiculo?: string | null
          valor_frete?: string | null
        }
        Relationships: []
      }
      driver_profiles: {
        Row: {
          active: boolean
          allowed_regions: string[]
          antt_valid: boolean
          created_at: string
          document_number: string | null
          documents_valid: boolean
          full_name: string
          insurance_valid: boolean
          metadata: Json
          monitoring_capable: boolean
          operational_blocked: boolean
          phone: string | null
          tracking_enabled: boolean
          updated_at: string
          user_id: string
          vehicle_profile: string
        }
        Insert: {
          active?: boolean
          allowed_regions?: string[]
          antt_valid?: boolean
          created_at?: string
          document_number?: string | null
          documents_valid?: boolean
          full_name: string
          insurance_valid?: boolean
          metadata?: Json
          monitoring_capable?: boolean
          operational_blocked?: boolean
          phone?: string | null
          tracking_enabled?: boolean
          updated_at?: string
          user_id: string
          vehicle_profile?: string
        }
        Update: {
          active?: boolean
          allowed_regions?: string[]
          antt_valid?: boolean
          created_at?: string
          document_number?: string | null
          documents_valid?: boolean
          full_name?: string
          insurance_valid?: boolean
          metadata?: Json
          monitoring_capable?: boolean
          operational_blocked?: boolean
          phone?: string | null
          tracking_enabled?: boolean
          updated_at?: string
          user_id?: string
          vehicle_profile?: string
        }
        Relationships: []
      }
      idempotency_records: {
        Row: {
          correlation_id: string | null
          created_at: string
          driver_id: string
          expires_at: string
          id: string
          idempotency_key: string
          load_id: string
          request_hash: string
          response_body_json: Json | null
          response_status: number | null
          scope: string
        }
        Insert: {
          correlation_id?: string | null
          created_at?: string
          driver_id: string
          expires_at: string
          id?: string
          idempotency_key: string
          load_id: string
          request_hash: string
          response_body_json?: Json | null
          response_status?: number | null
          scope: string
        }
        Update: {
          correlation_id?: string | null
          created_at?: string
          driver_id?: string
          expires_at?: string
          id?: string
          idempotency_key?: string
          load_id?: string
          request_hash?: string
          response_body_json?: Json | null
          response_status?: number | null
          scope?: string
        }
        Relationships: [
          {
            foreignKeyName: "idempotency_records_load_id_fkey"
            columns: ["load_id"]
            isOneToOne: false
            referencedRelation: "cargas"
            referencedColumns: ["id"]
          },
        ]
      }
      load_claim_events: {
        Row: {
          actor_id: string | null
          actor_type: string
          claim_id: string | null
          correlation_id: string | null
          created_at: string
          driver_id: string | null
          event_payload_json: Json
          event_type: string
          id: string
          load_id: string
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          claim_id?: string | null
          correlation_id?: string | null
          created_at?: string
          driver_id?: string | null
          event_payload_json?: Json
          event_type: string
          id?: string
          load_id: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          claim_id?: string | null
          correlation_id?: string | null
          created_at?: string
          driver_id?: string | null
          event_payload_json?: Json
          event_type?: string
          id?: string
          load_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "load_claim_events_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "load_claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "load_claim_events_load_id_fkey"
            columns: ["load_id"]
            isOneToOne: false
            referencedRelation: "cargas"
            referencedColumns: ["id"]
          },
        ]
      }
      load_claims: {
        Row: {
          claimed_at: string
          confirmed_at: string | null
          correlation_id: string | null
          created_at: string
          driver_id: string
          expired_at: string | null
          id: string
          idempotency_key: string
          load_id: string
          promoted_at: string | null
          queue_position: number | null
          rejected_reason: string | null
          request_fingerprint: string
          request_payload_json: Json
          server_sequence: number
          status: string
          updated_at: string
        }
        Insert: {
          claimed_at?: string
          confirmed_at?: string | null
          correlation_id?: string | null
          created_at?: string
          driver_id: string
          expired_at?: string | null
          id?: string
          idempotency_key: string
          load_id: string
          promoted_at?: string | null
          queue_position?: number | null
          rejected_reason?: string | null
          request_fingerprint: string
          request_payload_json?: Json
          server_sequence?: number
          status: string
          updated_at?: string
        }
        Update: {
          claimed_at?: string
          confirmed_at?: string | null
          correlation_id?: string | null
          created_at?: string
          driver_id?: string
          expired_at?: string | null
          id?: string
          idempotency_key?: string
          load_id?: string
          promoted_at?: string | null
          queue_position?: number | null
          rejected_reason?: string | null
          request_fingerprint?: string
          request_payload_json?: Json
          server_sequence?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "load_claims_load_id_fkey"
            columns: ["load_id"]
            isOneToOne: false
            referencedRelation: "cargas"
            referencedColumns: ["id"]
          },
        ]
      }
      load_public_lead_events: {
        Row: {
          actor_id: string | null
          actor_type: string
          created_at: string
          event_payload_json: Json
          event_type: string
          id: string
          lead_id: string
          load_id: string
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          created_at?: string
          event_payload_json?: Json
          event_type: string
          id?: string
          lead_id: string
          load_id: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          created_at?: string
          event_payload_json?: Json
          event_type?: string
          id?: string
          lead_id?: string
          load_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "load_public_lead_events_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "load_public_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "load_public_lead_events_load_id_fkey"
            columns: ["load_id"]
            isOneToOne: false
            referencedRelation: "cargas"
            referencedColumns: ["id"]
          },
        ]
      }
      load_public_leads: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          cpf: string
          created_at: string
          horse_plate: string
          id: string
          load_id: string
          phone: string
          pre_registered_at: string
          queued_at: string | null
          status: string
          validation_checked_at: string | null
          validation_status: string
          validation_summary_json: Json
          trailer_plate: string
          trailer_plate_2: string
          updated_at: string
          vehicle_type: string
          whatsapp_clicked_at: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          cpf: string
          created_at?: string
          horse_plate: string
          id?: string
          load_id: string
          phone: string
          pre_registered_at?: string
          queued_at?: string | null
          status?: string
          validation_checked_at?: string | null
          validation_status?: string
          validation_summary_json?: Json
          trailer_plate: string
          trailer_plate_2?: string
          updated_at?: string
          vehicle_type: string
          whatsapp_clicked_at?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          cpf?: string
          created_at?: string
          horse_plate?: string
          id?: string
          load_id?: string
          phone?: string
          pre_registered_at?: string
          queued_at?: string | null
          status?: string
          validation_checked_at?: string | null
          validation_status?: string
          validation_summary_json?: Json
          trailer_plate?: string
          trailer_plate_2?: string
          updated_at?: string
          vehicle_type?: string
          whatsapp_clicked_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "load_public_leads_load_id_fkey"
            columns: ["load_id"]
            isOneToOne: false
            referencedRelation: "cargas"
            referencedColumns: ["id"]
          },
        ]
      }
      route_metrics_cache: {
        Row: {
          ativa: boolean
          bonus_padrao: number | null
          created_at: string
          destination_key: string
          destino: string
          distancia_km: number
          duracao_horas: number
          id: string
          observacoes: string | null
          origin_key: string
          origem: string
          perfil_padrao: string | null
          tempo_estimado_horas: number | null
          updated_at: string
          valor_padrao: number | null
        }
        Insert: {
          ativa?: boolean
          bonus_padrao?: number | null
          created_at?: string
          destination_key: string
          destino: string
          distancia_km: number
          duracao_horas: number
          id?: string
          observacoes?: string | null
          origin_key: string
          origem: string
          perfil_padrao?: string | null
          tempo_estimado_horas?: number | null
          updated_at?: string
          valor_padrao?: number | null
        }
        Update: {
          ativa?: boolean
          bonus_padrao?: number | null
          created_at?: string
          destination_key?: string
          destino?: string
          distancia_km?: number
          duracao_horas?: number
          id?: string
          observacoes?: string | null
          origin_key?: string
          origem?: string
          perfil_padrao?: string | null
          tempo_estimado_horas?: number | null
          updated_at?: string
          valor_padrao?: number | null
        }
        Relationships: []
      }
    }
    Views: {
      load_claim_metrics_daily: {
        Row: {
          claims_confirmed: number | null
          claims_created: number | null
          claims_expired: number | null
          claims_promoted: number | null
          claims_rejected: number | null
          claims_waitlisted: number | null
          idempotent_replays: number | null
          metric_day: string | null
          reservations_created: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof DatabaseWithoutInternals, "public">]

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
      Row: infer RowType
    }
    ? RowType
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer RowType
      }
      ? RowType
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
      Insert: infer InsertType
    }
    ? InsertType
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer InsertType
      }
      ? InsertType
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
      Update: infer UpdateType
    }
    ? UpdateType
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer UpdateType
      }
      ? UpdateType
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
    Enums: {},
  },
} as const
