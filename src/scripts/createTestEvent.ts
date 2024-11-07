import { PrismaClient, DataSource } from "@prisma/client";
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function validateDevDatabase() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL not found in environment variables");
  }
  
  if (!dbUrl.endsWith('dev')) {
    throw new Error(
      "DATABASE_URL must end with 'dev' for testing. Please modify your .env file to use a development database.\n" +
      "Current DATABASE_URL: " + dbUrl + "\n" +
      "Example: postgresql://dormsoup:Hakken23@localhost:5432/dormsoup_dev"
    );
  }

  // Extract database name from URL
  const dbName = dbUrl.split('/').pop();
  
  try {
    // Check if database exists
    await execAsync(`psql -lqt | cut -d \\| -f 1 | grep -w ${dbName}`);
  } catch (error) {
    console.log(`Database '${dbName}' not found. Creating it...`);
    await execAsync(`createdb ${dbName}`);
    console.log(`Created database '${dbName}'`);
    
    // Push schema to new database
    await execAsync('npx prisma db push');
    console.log('Pushed schema to new database');
  }
}

async function main() {
  await validateDevDatabase();
  
  const prisma = new PrismaClient();
  await prisma.$connect();

  try {
    // Create EmailSender (required for Email)
    const sender = await prisma.emailSender.upsert({
      where: { email: "test@mit.edu" },
      update: {},
      create: {
        email: "test@mit.edu",
        name: "Test User"
      }
    });

    // Create Email (required for Event)
    const email = await prisma.email.upsert({
      where: { messageId: "test-message-id" },
      update: {},
      create: {
        scrapedBy: "test-script",
        uid: 1,
        messageId: "test-message-id",
        receivedAt: new Date(),
        senderEmail: sender.email,
        subject: "Test Event Email",
        body: "This is a test event body"
      }
    });

    // Create Event
    const event = await prisma.event.create({
      data: {
        source: DataSource.MANUAL_INPUT,
        fromEmailId: email.messageId,
        text: "This is a test event description",
        title: "Test Event",
        organizer: "Test Organizer",
        date: new Date(),
        location: "Test Location",
        duration: 60
      }
    });

    console.log("Created test event:", event);
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });