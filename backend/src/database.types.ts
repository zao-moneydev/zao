export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.18";
  };
  public: {
    Tables: {
      anchor_txs: {
        Row: {
          created_at: number;
          id: string;
          kind: string;
          status: string;
          url: string | null;
          user_id: string;
        };
        Insert: {
          created_at: number;
          id: string;
          kind: string;
          status: string;
          url?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: number;
          id?: string;
          kind?: string;
          status?: string;
          url?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "anchor_txs_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      escrows: {
        Row: {
          amount: string;
          buyer_id: string;
          close_tx: string | null;
          create_tx: string | null;
          created_at: number;
          fund_tx: string | null;
          id: number;
          onchain_id: number | null;
          seller_id: string;
          status: string;
        };
        Insert: {
          amount: string;
          buyer_id: string;
          close_tx?: string | null;
          create_tx?: string | null;
          created_at: number;
          fund_tx?: string | null;
          id?: number;
          onchain_id?: number | null;
          seller_id: string;
          status: string;
        };
        Update: {
          amount?: string;
          buyer_id?: string;
          close_tx?: string | null;
          create_tx?: string | null;
          created_at?: number;
          fund_tx?: string | null;
          id?: number;
          onchain_id?: number | null;
          seller_id?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "escrows_buyer_id_fkey";
            columns: ["buyer_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "escrows_seller_id_fkey";
            columns: ["seller_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      groups: {
        Row: {
          create_tx: string | null;
          created_at: number;
          id: number;
          leader_id: string;
          member_ids: string;
          onchain_id: number | null;
        };
        Insert: {
          create_tx?: string | null;
          created_at: number;
          id?: number;
          leader_id: string;
          member_ids: string;
          onchain_id?: number | null;
        };
        Update: {
          create_tx?: string | null;
          created_at?: number;
          id?: number;
          leader_id?: string;
          member_ids?: string;
          onchain_id?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "groups_leader_id_fkey";
            columns: ["leader_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      loans: {
        Row: {
          created_at: number;
          default_tx: string | null;
          disburse_tx: string | null;
          disbursed_at: number | null;
          due_amount: string;
          due_at: number | null;
          flagged_overdue: number;
          group_id: number;
          id: number;
          onchain_id: number | null;
          principal: string;
          repay_tx: string | null;
          request_tx: string | null;
          signatures: string;
          status: string;
        };
        Insert: {
          created_at: number;
          default_tx?: string | null;
          disburse_tx?: string | null;
          disbursed_at?: number | null;
          due_amount: string;
          due_at?: number | null;
          flagged_overdue?: number;
          group_id: number;
          id?: number;
          onchain_id?: number | null;
          principal: string;
          repay_tx?: string | null;
          request_tx?: string | null;
          signatures?: string;
          status: string;
        };
        Update: {
          created_at?: number;
          default_tx?: string | null;
          disburse_tx?: string | null;
          disbursed_at?: number | null;
          due_amount?: string;
          due_at?: number | null;
          flagged_overdue?: number;
          group_id?: number;
          id?: number;
          onchain_id?: number | null;
          principal?: string;
          repay_tx?: string | null;
          request_tx?: string | null;
          signatures?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "loans_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "groups";
            referencedColumns: ["id"];
          },
        ];
      };
      sessions: {
        Row: {
          created_at: number;
          token: string;
          user_id: string;
        };
        Insert: {
          created_at: number;
          token: string;
          user_id: string;
        };
        Update: {
          created_at?: number;
          token?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sessions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      users: {
        Row: {
          created_at: number;
          email: string;
          id: string;
          kyc_id: string | null;
          kyc_status: string;
          name: string;
          public_key: string;
          secret_enc: string;
        };
        Insert: {
          created_at: number;
          email: string;
          id: string;
          kyc_id?: string | null;
          kyc_status?: string;
          name: string;
          public_key: string;
          secret_enc: string;
        };
        Update: {
          created_at?: number;
          email?: string;
          id?: string;
          kyc_id?: string | null;
          kyc_status?: string;
          name?: string;
          public_key?: string;
          secret_enc?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};
