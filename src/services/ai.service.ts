// DEPLOY Platform - AI Orchestration Service (Intent Layer)
// ALL AI operations MUST enter through this layer.
// Provider keys are NEVER exposed to clients.

import type { Bindings } from '../types';

export type IntentPayload = {
  intent: 'complete_prompt_field' | 'generate_spec' | 'generate_build' | 'generate_revision' | 'analyze_completeness';
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
};

// System prompts by intent type
const SYSTEM_PROMPTS: Record<string, string> = {
  complete_prompt_field: `You are a precision product assistant helping users define their app idea.
Given the context of what they've filled in so far and the field they need help with,
provide a focused, clear, beginner-friendly suggestion. Keep it concise. Do not add fluff.`,

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
Return as valid JSON.`
};

export class AIService {
  constructor(
    private env: Bindings,
    private db: D1Database
  ) {}

  // The single entry point for ALL AI operations
  async processIntent(payload: IntentPayload): Promise<IntentResult> {
    try {
      // Lookup model
      const model = await this.db.prepare(
        'SELECT * FROM ai_models WHERE id = ? AND is_active = 1'
      ).bind(payload.modelId).first<{
        id: string; model_id: string; provider_id: string;
        base_coin_cost: number; coin_cost_multiplier: number;
      }>();

      if (!model) {
        return { success: false, error: 'Model not found or unavailable' };
      }

      // Get provider
      const provider = await this.db.prepare(
        'SELECT slug FROM ai_providers WHERE id = ?'
      ).bind(model.provider_id).first<{ slug: string }>();

      if (!provider) {
        return { success: false, error: 'Provider not found' };
      }

      const systemPrompt = SYSTEM_PROMPTS[payload.intent] || 'You are a helpful AI assistant for the DEPLOY platform.';
      const userMessage = this.buildUserMessage(payload);

      let result: IntentResult;

      if (provider.slug === 'openai') {
        result = await this.callOpenAI(model.model_id, systemPrompt, userMessage);
      } else if (provider.slug === 'anthropic') {
        result = await this.callAnthropic(model.model_id, systemPrompt, userMessage);
      } else {
        return { success: false, error: 'Unsupported provider' };
      }

      // Log usage
      if (result.success) {
        const coinsCharged = Math.ceil(model.base_coin_cost * model.coin_cost_multiplier);
        result.coinsCharged = coinsCharged;
        
        await this.db.prepare(
          'INSERT INTO model_usage_events (id, user_id, model_id, project_id, tokens_input, tokens_output, coins_spent, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          crypto.randomUUID(), payload.userId, payload.modelId,
          payload.projectId || null, result.tokensUsed || 0, 0, coinsCharged, 'completed'
        ).run();
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

Please suggest a value for "${ctx.field_key}".`;
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

    return JSON.stringify(ctx);
  }

  private async callOpenAI(modelId: string, systemPrompt: string, userMessage: string): Promise<IntentResult> {
    const apiKey = this.env.OPENAI_API_KEY;
    if (!apiKey) return { success: false, error: 'AI service temporarily unavailable' };

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
      const err = await response.text();
      console.error('OpenAI error:', err);
      return { success: false, error: 'AI provider error. Please try again.' };
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
    };

    const content = data.choices[0]?.message?.content || '';
    
    // Try to parse as JSON for structured intents
    let structured: Record<string, unknown> | undefined;
    try {
      structured = JSON.parse(content);
    } catch {
      // Not JSON, that's fine
    }

    return {
      success: true,
      output: content,
      structured,
      tokensUsed: data.usage?.total_tokens || 0
    };
  }

  private async callAnthropic(modelId: string, systemPrompt: string, userMessage: string): Promise<IntentResult> {
    const apiKey = this.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { success: false, error: 'AI service temporarily unavailable' };

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
      return { success: false, error: 'AI provider error. Please try again.' };
    }

    const data = await response.json() as {
      content: Array<{ text: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };

    const content = data.content[0]?.text || '';

    let structured: Record<string, unknown> | undefined;
    try {
      structured = JSON.parse(content);
    } catch {
      // Not JSON
    }

    return {
      success: true,
      output: content,
      structured,
      tokensUsed: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
    };
  }
}
