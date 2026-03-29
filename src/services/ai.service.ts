// DEPLOY Platform - AI Orchestration Service (Intent Layer)
// ALL AI operations MUST enter through this layer.
// Provider keys are NEVER exposed to clients.

import type { Bindings } from '../types';

export type IntentPayload = {
  intent: 'complete_prompt_field' | 'generate_spec' | 'generate_build' | 'generate_revision' | 'analyze_completeness' | 'chat' | 'summarize_build';
  userId: string;
  projectId?: string;
  sessionId?: string;
  modelId: string;
  context: Record<string, unknown>;
  coinBudget?: number;
};

export type IntentResult = {
  success: boolean;
  output?: string;
  structured?: Record<string, unknown>;
  tokensUsed?: number;
  coinsCharged?: number;
  error?: string;
  provider_used?: string;
};

// System prompts by intent type
const SYSTEM_PROMPTS: Record<string, string> = {
  complete_prompt_field: `You are a precision product assistant helping users define their app idea.
Given the context of what they've filled in so far and the field they need help with,
provide a focused, clear, beginner-friendly suggestion. Keep it concise (2-4 sentences max). Do not add fluff.`,

  generate_spec: `You are a senior software architect and product strategist.
Given the user's filled app blueprint, produce a structured product specification.
Output must include: product_summary, feature_map, screen_map, role_map, data_map, workflow_map, api_plan, deployment_plan, risk_flags, missing_info_flags, readiness_score (0-100).
Return as valid JSON only.`,

  generate_build: `You are a principal full-stack engineer and system architect.
Given the product spec, generate a complete, production-ready implementation plan.
Include: architecture overview, tech stack decisions, folder structure, key file outlines, API contracts, database schema, deployment steps.
Be specific, practical, and production-safe. No boilerplate fluff.`,

  generate_revision: `You are a careful software engineer performing a surgical revision.
Acknowledge the change, identify blast radius, preserve working systems, and implement only what was requested.
Return: change_summary, affected_areas, implementation_plan, backward_compatibility_notes.`,

  analyze_completeness: `You are a product completeness analyzer.
Review the prompt fields provided and return a completeness_score (0-100), missing_fields list, and specific recommendations for each gap.
Return as valid JSON.`,

  chat: `You are DEPLOY's intelligent build assistant. You have deep knowledge of the app that was just built.
Answer user questions concisely and helpfully. Reference specific details from the build context when relevant.
Be conversational but precise. If asked about implementation details, provide clear technical guidance.`,

  summarize_build: `You are a technical writer for software products.
Given the build specification and implementation plan, write a clear 3-5 paragraph summary of the app's functionality.
Write for a non-technical audience. Cover: what the app does, who it's for, key features, how it works at a high level, and what makes it unique.
Be enthusiastic but accurate. No jargon.`
};

// Fallback model mapping: if primary provider fails, try alternate
const FALLBACK_MODELS: Record<string, { modelId: string; provider: string }> = {
  'openai': { modelId: 'claude-3-5-haiku-20241022', provider: 'anthropic' },
  'anthropic': { modelId: 'gpt-4o-mini', provider: 'openai' },
};

export class AIService {
  constructor(
    private env: Bindings,
    private db: D1Database
  ) {}

  // The single entry point for ALL AI operations
  async processIntent(payload: IntentPayload): Promise<IntentResult> {
    try {
      // Lookup model - try exact match first, then fallback to any active model
      let model = await this.db.prepare(
        'SELECT * FROM ai_models WHERE id = ? AND is_active = 1'
      ).bind(payload.modelId).first<{
        id: string; model_id: string; provider_id: string;
        base_coin_cost: number; coin_cost_multiplier: number;
      }>();

      // If model not found, fall back to gpt-4o-mini or claude-3-5-haiku
      if (!model) {
        model = await this.db.prepare(
          "SELECT * FROM ai_models WHERE id IN ('model_gpt4o_mini','model_claude_haiku') AND is_active = 1 LIMIT 1"
        ).first<{
          id: string; model_id: string; provider_id: string;
          base_coin_cost: number; coin_cost_multiplier: number;
        }>();
      }

      if (!model) {
        // Last resort: any active model
        model = await this.db.prepare(
          'SELECT * FROM ai_models WHERE is_active = 1 LIMIT 1'
        ).first<{
          id: string; model_id: string; provider_id: string;
          base_coin_cost: number; coin_cost_multiplier: number;
        }>();
      }

      if (!model) {
        return { success: false, error: 'No AI models available. Please contact support.' };
      }

      // Get provider
      const provider = await this.db.prepare(
        'SELECT id, slug FROM ai_providers WHERE id = ?'
      ).bind(model.provider_id).first<{ id: string; slug: string }>();

      if (!provider) {
        return { success: false, error: 'AI provider configuration error.' };
      }

      const systemPrompt = SYSTEM_PROMPTS[payload.intent] || 'You are a helpful AI assistant for the DEPLOY platform.';
      const userMessage = this.buildUserMessage(payload);

      let result: IntentResult;

      // Try primary provider
      if (provider.slug === 'openai') {
        result = await this.callOpenAI(model.model_id, systemPrompt, userMessage);
      } else if (provider.slug === 'anthropic') {
        result = await this.callAnthropic(model.model_id, systemPrompt, userMessage);
      } else {
        return { success: false, error: 'Unsupported AI provider.' };
      }

      // If primary provider failed, try fallback
      if (!result.success) {
        console.log(`Primary provider ${provider.slug} failed, trying fallback...`);
        const fallback = FALLBACK_MODELS[provider.slug];
        
        if (fallback) {
          let fallbackResult: IntentResult;
          if (fallback.provider === 'anthropic') {
            fallbackResult = await this.callAnthropic(fallback.modelId, systemPrompt, userMessage);
          } else {
            fallbackResult = await this.callOpenAI(fallback.modelId, systemPrompt, userMessage);
          }
          
          if (fallbackResult.success) {
            console.log(`Fallback to ${fallback.provider} succeeded`);
            result = fallbackResult;
            result.provider_used = fallback.provider;
          }
        }
      } else {
        result.provider_used = provider.slug;
      }

      // Log usage
      if (result.success) {
        const coinsCharged = Math.ceil(model.base_coin_cost * model.coin_cost_multiplier);
        result.coinsCharged = coinsCharged;
        
        try {
          await this.db.prepare(
            'INSERT INTO model_usage_events (id, user_id, model_id, project_id, tokens_input, tokens_output, coins_spent, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(
            crypto.randomUUID(), payload.userId, model.id,
            payload.projectId || null, result.tokensUsed || 0, 0, coinsCharged, 'completed'
          ).run();
        } catch (logErr) {
          // Non-fatal: don't fail the request just because logging failed
          console.error('Usage log error:', logErr);
        }
      }

      return result;
    } catch (err) {
      console.error('AI Intent error:', err);
      return { success: false, error: 'AI processing failed. Please try again.' };
    }
  }

  private buildUserMessage(payload: IntentPayload): string {
    const ctx = payload.context;
    
    if (payload.intent === 'complete_prompt_field') {
      return `Field to complete: ${ctx.field_key}
Section: ${ctx.section_key}
Current value (if any): ${ctx.current_value || 'empty'}

Project context so far:
App Name: ${ctx.app_name || 'not set'}
Category: ${ctx.category || 'not set'}
Audience: ${ctx.audience || 'not set'}
Problem: ${ctx.problem || 'not set'}

Please suggest a value for "${ctx.field_key}". Be concise and specific.`;
    }

    if (payload.intent === 'generate_spec') {
      return `Generate a full product specification for this app:

${JSON.stringify(ctx.prompt_data, null, 2)}

Return as structured JSON matching the spec format.`;
    }

    if (payload.intent === 'analyze_completeness') {
      return `Analyze the completeness of this app blueprint:

${JSON.stringify(ctx.fields, null, 2)}

Return JSON with: completeness_score (0-100), missing_fields (array), recommendations (object by field).`;
    }

    if (payload.intent === 'chat') {
      return `Build Context:
App: ${ctx.app_name || 'Unknown'}
Category: ${ctx.category || 'Unknown'}
Build Summary: ${ctx.build_summary || 'Not available'}

User Question: ${ctx.message}

Answer helpfully and concisely.`;
    }

    if (payload.intent === 'summarize_build') {
      return `Please write a 3-5 paragraph summary of this app for the user:

App Name: ${ctx.app_name || 'Unknown App'}
Category: ${ctx.category || 'Unknown'}
Build Output:
${ctx.build_output ? (ctx.build_output as string).substring(0, 3000) : 'No build data available'}

Write in plain English, no jargon. Cover what it does, who it's for, and key features.`;
    }

    if (payload.intent === 'generate_revision') {
      return `Perform a surgical revision:

Original Build Context:
${ctx.build_summary ? (ctx.build_summary as string).substring(0, 2000) : 'Not available'}

Requested Change:
${ctx.revision_notes}

Return: change_summary, affected_areas, implementation_plan, backward_compatibility_notes.`;
    }

    return JSON.stringify(ctx);
  }

  private async callOpenAI(modelId: string, systemPrompt: string, userMessage: string): Promise<IntentResult> {
    const apiKey = this.env.OPENAI_API_KEY;
    if (!apiKey) return { success: false, error: 'OpenAI API key not configured' };

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
          ],
          max_tokens: 4096,
          temperature: 0.7,
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`OpenAI error ${response.status}:`, errText);
        
        // Check for quota/billing errors specifically
        if (response.status === 429 || response.status === 402) {
          return { success: false, error: 'openai_quota_exceeded' };
        }
        return { success: false, error: `OpenAI error: ${response.status}` };
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
        usage: { total_tokens: number };
      };

      const content = data.choices?.[0]?.message?.content || '';
      
      let structured: Record<string, unknown> | undefined;
      try { structured = JSON.parse(content); } catch { /* not JSON */ }

      return {
        success: true,
        output: content,
        structured,
        tokensUsed: data.usage?.total_tokens || 0
      };
    } catch (err) {
      console.error('OpenAI fetch error:', err);
      return { success: false, error: 'OpenAI connection error' };
    }
  }

  private async callAnthropic(modelId: string, systemPrompt: string, userMessage: string): Promise<IntentResult> {
    const apiKey = this.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { success: false, error: 'Anthropic API key not configured' };

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`Anthropic error ${response.status}:`, errText);
        
        if (response.status === 429 || response.status === 402) {
          return { success: false, error: 'anthropic_quota_exceeded' };
        }
        return { success: false, error: `Anthropic error: ${response.status}` };
      }

      const data = await response.json() as {
        content: Array<{ text: string }>;
        usage: { input_tokens: number; output_tokens: number };
      };

      const content = data.content?.[0]?.text || '';

      let structured: Record<string, unknown> | undefined;
      try { structured = JSON.parse(content); } catch { /* not JSON */ }

      return {
        success: true,
        output: content,
        structured,
        tokensUsed: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
      };
    } catch (err) {
      console.error('Anthropic fetch error:', err);
      return { success: false, error: 'Anthropic connection error' };
    }
  }
}
