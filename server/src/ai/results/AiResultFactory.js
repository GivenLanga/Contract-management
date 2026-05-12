'use strict';

const EMPTY_ARRAY = Object.freeze([]);
const EMPTY_OBJECT = Object.freeze({});

const ensureSummary = (result) => {
  if (result.summary) return result.summary;
  const count = result.metrics?.count ?? result.metrics?.total ?? result.items?.length ?? result.rows?.length;
  if (typeof count === 'number') return `${result.title || 'Result'}: ${count} item${count !== 1 ? 's' : ''}.`;
  return result.title || 'No result summary is available.';
};

const makeResult = ({
  type,
  category,
  title,
  summary,
  metrics = EMPTY_OBJECT,
  items = EMPTY_ARRAY,
  columns = EMPTY_ARRAY,
  rows = EMPTY_ARRAY,
  sections = EMPTY_ARRAY,
  warnings = EMPTY_ARRAY,
  actions = EMPTY_ARRAY,
  ...rest
}) => {
  const result = {
    type,
    category,
    title,
    summary,
    metrics,
    items,
    columns,
    rows,
    sections,
    warnings,
    actions,
    ...rest,
  };
  result.summary = ensureSummary(result);
  return result;
};

const clarificationRequired = ({ summary, title = 'Clarification Needed', options = [] }) =>
  makeResult({
    type: 'clarification_required',
    category: 'app_data',
    title,
    summary,
    metrics: {},
    items: [],
    options,
  });

const toolError = ({ title = 'Tool Error', summary, toolName }) =>
  makeResult({
    type: 'tool_error',
    category: 'tool_error',
    title,
    summary: summary || 'The assistant could not complete that lookup safely.',
    metrics: {},
    items: [],
    toolName,
  });

module.exports = {
  clarificationRequired,
  makeResult,
  toolError,
};
