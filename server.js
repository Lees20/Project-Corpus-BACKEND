const { Client } = require('@notionhq/client');
const fs = require('fs');
const config = require('./config/config');
const express = require('express');
const cors = require('cors');

// Initialize the Notion client with API key
const notion = new Client({ auth: config.NOTION_API_KEY });

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Use CORS middleware
app.use(cors());

// Set to track visited blocks to avoid redundant fetching
const visitedBlocks = new Set();

// Function to fetch all pages from a Notion database
async function fetchPages(databaseId) {
  let results = [];
  let hasMore = true;
  let nextCursor = undefined;

  try {
    while (hasMore) {
      console.log(`Fetching pages from database: ${databaseId} (cursor: ${nextCursor || 'start'})`);
      const response = await notion.databases.query({
        database_id: databaseId,
        start_cursor: nextCursor,
      });
      results = results.concat(response.results);
      hasMore = response.has_more;
      nextCursor = response.next_cursor;
      console.log(`Fetched ${response.results.length} pages, has_more: ${hasMore}`);
    }
  } catch (error) {
    console.error('Error fetching pages from Notion:', error);
  }

  return results;
}

// Function to fetch children of a block
async function fetchChildren(blockId) {
  let children = [];
  let hasMore = true;
  let nextCursor = undefined;

  try {
    while (hasMore) {
      console.log(`Fetching children for block: ${blockId} (cursor: ${nextCursor || 'start'})`);
      const response = await notion.blocks.children.list({
        block_id: blockId,
        start_cursor: nextCursor,
      });
      children = children.concat(response.results);
      hasMore = response.has_more;
      nextCursor = response.next_cursor;
      console.log(`Fetched ${response.results.length} children, has_more: ${hasMore}`);
    }
  } catch (error) {
    console.error('Error fetching children from Notion:', error);
  }

  return children;
}

// Function to recursively fetch pages and their children in depth, with a dynamic depth limit
async function fetchNestedPages(block, depth = 0, maxDepth = 5, overallDepthLimit = 7) {
  if (depth >= maxDepth || depth >= overallDepthLimit) {
    console.log(`Reached max depth (${maxDepth}) or overall depth limit (${overallDepthLimit}) for block: ${block.id}`);
    return [];
  }

  if (visitedBlocks.has(block.id)) {
    console.log(`Skipping already visited block: ${block.id}`);
    return [];
  }

  visitedBlocks.add(block.id);
  console.log(`Fetching nested pages for block: ${block.id} at depth: ${depth}`);
  const children = await fetchChildren(block.id);

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    console.log(`Processing child: ${child.id} (type: ${child.type})`);

    if (child.type === 'child_page') {
      console.log(`Child is a page, fetching nested pages for: ${child.id}`);
      child.children = await fetchNestedPages(child, depth + 1, maxDepth, overallDepthLimit);
    } else if (child.type === 'child_database') {
      console.log(`Child is a database, fetching pages for: ${child.id}`);
      child.pages = await fetchPages(child.id);
      for (let j = 0; j < child.pages.length; j++) {
        console.log(`Fetching nested pages for page: ${child.pages[j].id}`);
        child.pages[j].children = await fetchNestedPages(child.pages[j], depth + 1, maxDepth, overallDepthLimit);
      }
    } else if (child.has_children) {
      console.log(`Child has children, fetching nested pages for: ${child.id}`);
      child.children = await fetchNestedPages(child, depth + 1, maxDepth, overallDepthLimit);
    }
  }

  return children;
}

// Endpoint to trigger the data fetching and saving process
app.get('/api/fetch-articles', async (req, res) => {
  console.log('Request received for /api/fetch-articles');

  try {
    const databaseId = config.DATABASE_ID;
    console.log('Fetching data from Notion database...');

    const topLevelPages = await fetchPages(databaseId);

    // Fetch all nested pages and articles
    for (let i = 0; i < topLevelPages.length; i++) {
      const page = topLevelPages[i];
      console.log(`Processing top-level page: ${page.id}`);
      if (page.object === 'page' || page.object === 'block') {
        page.children = await fetchNestedPages(page);
      }
    }

    // Log top-level pages to inspect data
    console.log('Top-level pages fetched:', JSON.stringify(topLevelPages, null, 2));

    // Write the fetched data to articles.json
    fs.writeFile('articles.json', JSON.stringify(topLevelPages, null, 2), (err) => {
      if (err) {
        console.error('Error saving data to JSON file:', err);
        res.status(500).send('Error saving data to JSON file');
      } else {
        console.log('Data successfully saved to articles.json');
        res.send('Data successfully fetched and saved');
      }
    });
  } catch (error) {
    console.error('Error fetching data from Notion:', error);
    res.status(500).send('Error fetching data from Notion');
  }
});

// Endpoint to serve JSON data
app.get('/api/articles', (req, res) => {
  console.log('Request received for /api/articles');
  fs.readFile('articles.json', 'utf8', (err, data) => {
    if (err) {
      console.error('Error reading articles.json:', err);
      res.status(500).send('Internal Server Error');
    } else {
      console.log('Serving data from articles.json');
      res.json(JSON.parse(data));
    }
  });
});


// Updated route to get a single article by ID
app.get('/api/article/:id', (req, res) => {
  const articleId = req.params.id;

  // Read the JSON data each time the endpoint is called
  fs.readFile('articles.json', 'utf8', (err, data) => {
    if (err) {
      console.error('Error reading articles.json:', err);
      res.status(500).send('Internal Server Error');
      return;
    }

    try {
      const articlesData = JSON.parse(data);
      console.log('Searching for article with ID:', articleId);

      // Search for the article recursively
      function findArticleById(article, id) {
        if (article.id === id) {
          return article;
        }

        if (article.children) {
          for (let child of article.children) {
            const found = findArticleById(child, id);
            if (found) {
              return found;
            }
          }
        }

        if (article.pages) {
          for (let page of article.pages) {
            const found = findArticleById(page, id);
            if (found) {
              return found;
            }
          }
        }

        return null;
      }

      let foundArticle = null;
      for (let topLevelArticle of articlesData) {
        foundArticle = findArticleById(topLevelArticle, articleId);
        if (foundArticle) break;
      }

      if (foundArticle) {
        res.json(foundArticle);
      } else {
        console.log('Article not found for ID:', articleId);
        res.status(404).send('Article not found');
      }
    } catch (parseError) {
      console.error('Error parsing articles.json:', parseError);
      res.status(500).send('Error parsing JSON data');
    }
  });
});





// Start the Express server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});