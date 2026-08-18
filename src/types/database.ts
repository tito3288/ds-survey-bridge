export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      delivery_jobs: {
        Row: {
          accepted_at: string | null
          attempt_count: number
          claimed_by_run_id: string | null
          created_at: string
          first_provider_call_started_at: string | null
          id: string
          kind: Database["public"]["Enums"]["delivery_job_kind"]
          last_error_category: string | null
          last_error_code: string | null
          lease_expires_at: string | null
          lease_token: string | null
          next_attempt_at: string
          provider_call_started_at: string | null
          provider_message_id: string | null
          scheduled_at: string
          status: Database["public"]["Enums"]["delivery_job_status"]
          survey_id: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          attempt_count?: number
          claimed_by_run_id?: string | null
          created_at?: string
          first_provider_call_started_at?: string | null
          id?: string
          kind: Database["public"]["Enums"]["delivery_job_kind"]
          last_error_category?: string | null
          last_error_code?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          next_attempt_at: string
          provider_call_started_at?: string | null
          provider_message_id?: string | null
          scheduled_at: string
          status?: Database["public"]["Enums"]["delivery_job_status"]
          survey_id: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          attempt_count?: number
          claimed_by_run_id?: string | null
          created_at?: string
          first_provider_call_started_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["delivery_job_kind"]
          last_error_category?: string | null
          last_error_code?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          next_attempt_at?: string
          provider_call_started_at?: string | null
          provider_message_id?: string | null
          scheduled_at?: string
          status?: Database["public"]["Enums"]["delivery_job_status"]
          survey_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_jobs_survey_id_fkey"
            columns: ["survey_id"]
            isOneToOne: false
            referencedRelation: "surveys"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          created_at: string
          droptop_location_id: string
          google_review_url: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          droptop_location_id: string
          google_review_url: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          droptop_location_id?: string
          google_review_url?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      surveys: {
        Row: {
          additional_services_experience_score: number | null
          comment: string | null
          created_at: string
          customer_name: string | null
          customer_phone: string | null
          id: string
          location_id: string
          order_id: string
          questionnaire_submitted_at: string | null
          questionnaire_version: number | null
          rating: number | null
          responded_at: string | null
          sent_at: string | null
          service_speed_score: number | null
          services: Json | null
          survey_flow_version: number | null
          survey_token: string
          team_friendliness_score: number | null
          value_score: number | null
          vehicle_cleanliness_score: number | null
          wait_time_score: number | null
        }
        Insert: {
          additional_services_experience_score?: number | null
          comment?: string | null
          created_at?: string
          customer_name?: string | null
          customer_phone?: string | null
          id?: string
          location_id: string
          order_id: string
          questionnaire_submitted_at?: string | null
          questionnaire_version?: number | null
          rating?: number | null
          responded_at?: string | null
          sent_at?: string | null
          service_speed_score?: number | null
          services?: Json | null
          survey_flow_version?: number | null
          survey_token?: string
          team_friendliness_score?: number | null
          value_score?: number | null
          vehicle_cleanliness_score?: number | null
          wait_time_score?: number | null
        }
        Update: {
          additional_services_experience_score?: number | null
          comment?: string | null
          created_at?: string
          customer_name?: string | null
          customer_phone?: string | null
          id?: string
          location_id?: string
          order_id?: string
          questionnaire_submitted_at?: string | null
          questionnaire_version?: number | null
          rating?: number | null
          responded_at?: string | null
          sent_at?: string | null
          service_speed_score?: number | null
          services?: Json | null
          survey_flow_version?: number | null
          survey_token?: string
          team_friendliness_score?: number | null
          value_score?: number | null
          vehicle_cleanliness_score?: number | null
          wait_time_score?: number | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_delivery_jobs: {
        Args: {
          p_lease_seconds: number
          p_limit: number
          p_now: string
          p_run_id: string
        }
        Returns: {
          attempt_count: number
          id: string
          kind: Database["public"]["Enums"]["delivery_job_kind"]
          lease_expires_at: string
          lease_token: string
          next_attempt_at: string
          scheduled_at: string
          status: Database["public"]["Enums"]["delivery_job_status"]
          survey_id: string
        }[]
      }
      complete_questionnaire_with_email_job: {
        Args: {
          p_additional_services_experience_score: number
          p_comment: string
          p_completed_at: string
          p_private_rating_maximum: number
          p_questionnaire_version: number
          p_service_speed_score: number
          p_survey_id: string
          p_team_friendliness_score: number
          p_value_score: number
          p_vehicle_cleanliness_score: number
          p_wait_time_score: number
        }
        Returns: {
          delivery_job_id: string
          location_id: string
          order_id: string
          outcome: string
          rating: number
          survey_id: string
        }[]
      }
      create_survey_with_sms_job: {
        Args: {
          p_customer_name: string
          p_customer_phone: string
          p_location_id: string
          p_order_id: string
          p_scheduled_at: string
          p_services: Json
        }
        Returns: {
          created: boolean
          delivery_job_id: string
          survey_id: string
          survey_token: string
        }[]
      }
      mark_delivery_job_dead: {
        Args: {
          p_error_category: string
          p_error_code: string
          p_failed_at: string
          p_job_id: string
          p_lease_token: string
        }
        Returns: boolean
      }
      mark_delivery_job_provider_started: {
        Args: { p_job_id: string; p_lease_token: string; p_started_at: string }
        Returns: {
          attempt_count: number
          started: boolean
        }[]
      }
      mark_delivery_job_retry: {
        Args: {
          p_error_category: string
          p_error_code: string
          p_failed_at: string
          p_job_id: string
          p_lease_token: string
        }
        Returns: {
          attempt_count: number
          next_attempt_at: string
          status: Database["public"]["Enums"]["delivery_job_status"]
        }[]
      }
      mark_delivery_job_sent: {
        Args: {
          p_accepted_at: string
          p_job_id: string
          p_lease_token: string
          p_provider_message_id: string
        }
        Returns: boolean
      }
      mark_delivery_job_unknown: {
        Args: {
          p_error_category: string
          p_error_code: string
          p_failed_at: string
          p_job_id: string
          p_lease_token: string
        }
        Returns: boolean
      }
    }
    Enums: {
      delivery_job_kind: "survey_sms" | "private_feedback_email"
      delivery_job_status:
        | "pending"
        | "processing"
        | "sent"
        | "dead"
        | "unknown"
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
      delivery_job_kind: ["survey_sms", "private_feedback_email"],
      delivery_job_status: ["pending", "processing", "sent", "dead", "unknown"],
    },
  },
} as const
