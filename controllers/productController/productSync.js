import path from 'path';
import { chunkArray, getAllPublications, loginAPI, logRecordToFile } from '../../helpers/index.js';
import {
  createProductBatch,
  getProductList,
  syncProductChangesHalfDay,
  syncProductChangesHourly,
  updateProductRelationships
} from "../../services/index.js";

// sync all product updates from external store to Shopify: ex storeName: DIAMOND
export const syncProductList = async ({ storeName, frequency }) => {
  try {    
    //using store's account to login API
    const access_token = await loginAPI({
      email: process.env[`${storeName}_EMAIL`],
      password: process.env[`${storeName}_PASSWORD`],
      store: storeName
    });

    console.log(`Getting All Product Updates from ${storeName} ${frequency}...`);
    
    //get Product List updated in the last 1 hour
    const product_list = await getProductList({
      store: storeName,
      access_token,
      action: "sync",
      frequency
    });

    console.log(`Syncing All Product Updates from ${storeName} ${frequency}...`);

    //sync the changes to Shopify
    if(product_list?.data?.length > 0){
      const limit_per_batch = 50;
      const product_list_batches = chunkArray(product_list.data, limit_per_batch);

      if(frequency == "halfday"){
        //sync product prices, images, product-creation and product-disable

        var newly_created_diamond_products = [];
        var queried_shopify_products = [];
        var created_shopify_products = [];
        var done = 0;
        
        // sync products in batches
        for (const product_list_batch of product_list_batches) {
          const result = await syncProductChangesHalfDay({
            store: storeName,
            product_list: product_list_batch,
            newly_created_diamond_products
          });

          done+=product_list_batch.length;
          console.log(`${done}/${product_list.data.length} products synced!`);

          if(result.status == "success"){
            if(result.newly_created_diamond_products)newly_created_diamond_products = result.newly_created_diamond_products;
            if(result.batch_queried_shopify_products)queried_shopify_products = queried_shopify_products.concat(result.batch_queried_shopify_products);
            if(result.batch_created_shopify_products)created_shopify_products = created_shopify_products.concat(result.batch_created_shopify_products);
          };
        };

        // Update newly-created Product's relationships after all products are created
        const diamond_products_in_relationship = newly_created_diamond_products.filter(product=>product.attributes.accessories.length > 0 || product.relationships?.includedProducts?.data?.length > 0 || product.attributes.replacement_product_id != null);
        if(diamond_products_in_relationship.length > 0) {
          await updateProductRelationships({ 
            diamond_products: diamond_products_in_relationship,
            queried_shopify_products: queried_shopify_products,
            created_shopify_products: created_shopify_products,
            store: storeName 
          });
        };
      } else if (frequency == "hourly") {
        // sync product stocks
        var done = 0;
        
        // sync products in batches
        for (const product_list_batch of product_list_batches) {
          const result = await syncProductChangesHourly({
            store: storeName,
            product_list: product_list_batch
          });

          if(result.status == "error")throw result.error;

          done+=product_list_batch.length;
          console.log(`${done}/${product_list.data.length} products synced!`);
        };
      };
    };

    console.log("***** All Products Synced *****");
  } catch (error) {
    console.log("Failed Syncing Products", error);
  }
};

// migrate all products from external store to Shopify: ex storeName: DIAMOND
export const migrateProductList = async (storeName) => {
  try {
    //error filePath to log errored records
    var error_file_number = 1;

    //using store's account to login API
    const access_token = await loginAPI({
      email: process.env[`${storeName}_EMAIL`],
      password: process.env[`${storeName}_PASSWORD`],
      store: storeName
    });

    console.log(`Getting All Publications from ${storeName}.....`);

    //get all publications
    const get_publication_result = await getAllPublications({
      store: storeName
    });
    const publications = get_publication_result.publications.nodes
    
    if(publications.length == 0)throw "There are no publications";

    console.log(`Getting All Products from ${storeName}.....`);
    
    //get all Products
    const product_list = await getProductList({
      store: storeName,
      access_token,
      action: "migrate"
    });

    console.log(`Migrating All Products from ${storeName}.....`);

    //upload all products to Shopify store
    if(product_list?.data?.length > 0){
      const limit_per_batch = 3;
      const product_list_batches = chunkArray(product_list.data, limit_per_batch);
      var done = 0;
      var created_products = [];

      for (const product_list_batch of product_list_batches) {
        const result = await createProductBatch({ product_list: product_list_batch, store: storeName, publications });

        done+=product_list_batch.length;
        console.log(`***** ${done}/${product_list.data.length} products migrated! *****`);

        //log error
        if(result.status != "success"){
          const failed_diamond_products = result.create_result.filter((product_result)=>!product_result.variant).map(product_result=>product_result.productData);
          if(failed_diamond_products.length > 0){
            failed_diamond_products.forEach(product=>{
              console.log(`***** Failed migrating product: ${product.attributes.name}! *****`);
            });

            //log error diamond product records to file for later check
            const errorPath = path.resolve(process.cwd(), 'logs', 'error_product_migrates', `errors_${error_file_number}.json`);
            error_file_number = logRecordToFile({ records: failed_diamond_products, filePath: errorPath });
          };
          console.log("errors", result.errors);
        } else {
          created_products = created_products.concat(result.create_result)
        }
      };
      
      console.log(`***** All Products Created! *****`);

      console.log(`Updating All Product Relationships from ${storeName}.....`);

      const diamond_products_in_relationship = product_list.data.filter(product=>product.attributes.accessories.length > 0 || product.relationships?.includedProducts?.data?.length > 0 || product.attributes.replacement_product_id != null);
    
      if(diamond_products_in_relationship.length > 0) {
        const update_result = await updateProductRelationships({ 
          diamond_products: diamond_products_in_relationship,
          queried_shopify_products: [],
          created_shopify_products: created_products,
          store: storeName
        });

        if(update_result.errors.length > 0)console.log(`Errors updating metafields `, update_result.errors);
      };

      console.log(`***** All Products Migrated! *****`);
    };

    return;
  } catch (error) {
    console.log("Error Migrating Products", error);
    return [];
  }
};

// update all product relationships after all products migrated: ex storeName: DIAMOND
export const migrateProductRelationshipList = async (storeName) => {
  //using store's account to login API
  const access_token = await loginAPI({
    email: process.env[`${storeName}_EMAIL`],
    password: process.env[`${storeName}_PASSWORD`],
    store: storeName
  });

  console.log(`Getting All Products from ${storeName}.....`);
  
  //get Product List updated in the last 1 hour
  const product_list = await getProductList({
    store: storeName,
    access_token,
    action: "migrate"
  });

  console.log(`Updating All Product Relationships from ${storeName}.....`);

  //Mass update all product relationships
  if(product_list.data.length > 0){
    const diamond_products_in_relationship = product_list.data.filter(product=>product.attributes.accessories.length > 0 || product.relationships?.includedProducts?.data?.length > 0 || product.attributes.replacement_product_id != null);
    
    if(diamond_products_in_relationship.length > 0) {
      const update_result = await updateProductRelationships({ 
        diamond_products: diamond_products_in_relationship,
        queried_shopify_products: [],
        created_shopify_products: [],
        store: storeName
      });

      if(update_result.errors.length > 0)console.log(`Errors updating metafields `, update_result.errors);
    };
  };

  console.log(`***** All Products Updated! *****`);
};
