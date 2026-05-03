/**
 * Extracts a structured tool call from a raw model output object.
 * Handles both native tool_call responses and text-embedded JSON.
 */
class ToolCallParser {
  /**
   * @param {object} modelOutput — the object returned by provider.generate()
   * @param {ToolRegistry} registry
   * @returns {{ toolName, arguments } | null}
   */
  parse(modelOutput, registry) {
    if (!modelOutput) return null;

    if (modelOutput.type === 'tool_call' && modelOutput.toolName) {
      const tool = registry.get(modelOutput.toolName);
      if (tool) return { toolName: modelOutput.toolName, arguments: modelOutput.arguments || {} };
    }

    if (modelOutput.type === 'assistant_message' && modelOutput.content) {
      return this._extractFromText(modelOutput.content, registry);
    }

    return null;
  }

  _extractFromText(text, registry) {
    const jsonCall = this._extractJsonCall(text, registry);
    if (jsonCall) return jsonCall;

    const functionCall = this._extractFunctionCall(text, registry);
    if (functionCall) return functionCall;

    return null;
  }

  _extractJsonCall(text, registry) {
    // Look for {"type":"tool_call","toolName":"...","arguments":{...}} pattern
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(text.slice(start, i + 1));
            const toolName = obj.toolName || obj.tool || obj.name;
            if ((obj.type === 'tool_call' || toolName) && toolName && registry.get(toolName)) {
              return { toolName, arguments: obj.arguments || obj.args || {} };
            }
          } catch {}
          break;
        }
      }
    }
    return null;
  }

  _extractFunctionCall(text, registry) {
    const trimmed = String(text || '').trim();
    const match = trimmed.match(/^([a-zA-Z_][\w]*)\s*\(([\s\S]*)\)\s*\.?$/);
    if (!match) return null;

    const [, toolName, rawArgs] = match;
    const tool = registry.get(toolName);
    if (!tool) return null;

    const args = this._parseFunctionArguments(rawArgs, tool);
    return { toolName, arguments: args };
  }

  _parseFunctionArguments(rawArgs, tool) {
    const text = String(rawArgs || '').trim();
    if (!text) return {};

    if (text.startsWith('{')) {
      try { return JSON.parse(text); } catch {}
    }

    const namedArgs = {};
    const namedMatches = [...text.matchAll(/([a-zA-Z_][\w]*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\s]+)/g)];
    if (namedMatches.length) {
      for (const match of namedMatches) {
        namedArgs[match[1]] = this._coerceFunctionValue(match[2]);
      }
      return namedArgs;
    }

    const positionalValue = this._coerceFunctionValue(text);
    const required = tool.schema?.required || [];
    const properties = Object.keys(tool.schema?.properties || {});
    const key = required[0] || properties[0] || 'query';
    return { [key]: positionalValue };
  }

  _coerceFunctionValue(value) {
    const trimmed = String(value || '').trim().replace(/,$/, '');
    if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

    const quoted = trimmed.match(/^"(.*)"$|^'(.*)'$/s);
    if (quoted) {
      const content = quoted[1] ?? quoted[2] ?? '';
      return content.replace(/\\(["'])/g, '$1');
    }

    return trimmed;
  }
}

module.exports = { ToolCallParser };
