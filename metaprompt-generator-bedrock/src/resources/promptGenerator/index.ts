import {
  ApolloClient,
  InMemoryCache,
  gql,
  createHttpLink,
} from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { promptTemplate } from './prompt';
import { typeDefs } from './typeDefs';

const APPSYNC_ENDPOINT = process.env.APPSYNC_ENDPOINT;
const APPSYNC_API_KEY = process.env.APPSYNC_API_KEY;
const BEDROCK_MODEL = process.env.BEDROCK_MODEL || 'anthropic.claude-3-sonnet-20240229-v1:0';

const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });

const httpLink = createHttpLink({
  uri: APPSYNC_ENDPOINT,
});

const authLink = setContext((_, { headers }) => {
  return {
    headers: {
      ...headers,
      'x-api-key': APPSYNC_API_KEY,
    },
  };
});

const apolloClient = new ApolloClient({
  link: authLink.concat(httpLink),
  cache: new InMemoryCache(),
  typeDefs: typeDefs,
});

const UPDATE_PROMPT_MUTATION_WITH_PROMPT = gql`
  mutation UpdatePrompt($id: ID!, $status: PromptStatus!, $prompt: String) {
    updatePrompt(id: $id, status: $status, prompt: $prompt) {
      id
      owner
      prompt
      status
      task
      variables
    }
  }
`;

const UPDATE_PROMPT_MUTATION = gql`
  mutation UpdatePrompt($id: ID!, $status: PromptStatus!) {
    updatePrompt(id: $id, status: $status) {
      id
      owner
      prompt
      status
      task
      variables
    }
  }
`;

export const lambdaHandler = async (event: any): Promise<void> => {
  console.log(event);
  const { promptId, task, variables = [] } = event;

  try {
    console.log(
      `Updating AppSync with promptID: ${promptId} and status: GENERATING`,
    );
    const generatingResponse = await apolloClient.mutate({
      mutation: UPDATE_PROMPT_MUTATION,
      variables: {
        id: promptId,
        status: 'GENERATING',
      },
    });
    console.log(
      `Generating Response: ${JSON.stringify(generatingResponse, null, 2)}`,
    );

    const updatedPrompt = promptTemplate.replace('{{TASK}}', task);
    console.log(`Updated Prompt: ${updatedPrompt}`);

    let variableString = '';
    variableString = variables
      .map((variable: string) => `{${variable.toUpperCase()}}`)
      .join('\n');

    let assistantPartial = '';
    if (variableString) {
      assistantPartial += '<Inputs>';
      assistantPartial += variableString + '\n</Inputs>\n';
    }
    assistantPartial += '<Instructions Structure>';
    console.log(`AssistantPartial: \n${assistantPartial}`);

    const input = {
      modelId: BEDROCK_MODEL,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        messages: [
          { role: 'user', content: updatedPrompt },
          { role: 'assistant', content: assistantPartial },
        ],
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 8192,
        temperature: 0,
      }),
    };

    const command = new InvokeModelCommand(input);
    const response = await bedrockClient.send(command);

    console.log(response);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    console.log('responseBody');
    console.log(responseBody);
    const generatedPrompt = extractPrompt(responseBody.content[0].text);
    console.log(`Response: \n${JSON.stringify(generatedPrompt, null, 2)}`);

    console.log(
      `Updating AppSync with promptID: ${promptId} and status: GENERATED`,
    );
    const generatedResponse = await apolloClient.mutate({
      mutation: UPDATE_PROMPT_MUTATION_WITH_PROMPT,
      variables: {
        id: promptId,
        status: 'GENERATED',
        prompt: generatedPrompt,
      },
    });
    console.log(
      `Generated Response: ${JSON.stringify(generatedResponse, null, 2)}`,
    );
  } catch (error) {
    console.error('Error generating prompt:', error);

    await apolloClient.mutate({
      mutation: UPDATE_PROMPT_MUTATION,
      variables: {
        id: promptId,
        status: 'ERROR',
      },
    });
  }
};

function extractBetweenTags(
  tag: string,
  text: string,
  strip: boolean = false,
): string[] {
  const regex = new RegExp(`<${tag}>(.+?)</${tag}>`, 'gs');
  const matches = text.match(regex);
  if (matches) {
    return strip
      ? matches.map((match) => match.replace(regex, '$1').trim())
      : matches.map((match) => match.replace(regex, '$1'));
  }
  return [];
}

function removeEmptyTags(text: string): string {
  return text.replace(/<(\w+)><\/\1>$/g, '');
}

function extractPrompt(content: any): string {
  console.log('content');
  console.log(content);
  if (typeof content === 'string') {
    const betweenTags = extractBetweenTags('Instructions', content)[0];
    if (betweenTags) {
      return removeEmptyTags(removeEmptyTags(betweenTags).trim()).trim();
    }
    throw new Error('No Instructions tags found in the response');
  }
  throw new Error('Invalid content format in the response');
}